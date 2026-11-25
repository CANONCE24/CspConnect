'use strict';
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const cloudinary = require('cloudinary').v2;
const { loadConfig } = require('../config/env');
const { httpError } = require('../utils/validation');
const uploadDir = path.resolve(__dirname, '../../public/uploads');
const validFilename = /^[a-f0-9-]+\.webp$/;
// Separate this application's assets from the previous website's images.
const publicId = filename => 'cspconnect-v2/' + filename.slice(0, -5);
function cloudOptions() {
  const config = loadConfig();
  if (config.uploadStorage !== 'cloudinary') return null;
  if (!config.cloudinaryCloudName || !config.cloudinaryApiKey || !config.cloudinaryApiSecret) {
    throw httpError(503, 'Image storage is not configured. Please contact the administrator.');
  }
  return { cloud_name: config.cloudinaryCloudName, api_key: config.cloudinaryApiKey,
    api_secret: config.cloudinaryApiSecret, resource_type: 'image', type: 'authenticated', timeout: 30000 };
}
const allowed = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 8, parts: 10, fieldSize: 40 * 1024 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed[ext] || allowed[ext] !== file.mimetype) return cb(httpError(422, 'Attach a JPG, PNG, or WebP image, up to 5 MB.'));
    cb(null, true);
  }
}).single('attachment');
async function saveImage(file, { avatar = false } = {}) {
  if (!file) return { attachmentPath: null, attachmentMime: null };
  let buffer;
  try {
    const bytes = file.buffer;
    const signatureMatches =
      (file.mimetype === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
      (file.mimetype === 'image/png' && bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
      (file.mimetype === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP');
    if (!signatureMatches) throw new Error('invalid file signature');
    const image = sharp(file.buffer, { limitInputPixels: 20000000, animated: false, failOn: 'warning' });
    const meta = await image.metadata();
    if (!['jpeg','png','webp'].includes(meta.format) || (meta.pages && meta.pages > 1)) throw new Error('invalid');
    const expected = {jpeg:'image/jpeg',png:'image/png',webp:'image/webp'}[meta.format];
    if (expected !== file.mimetype) throw new Error('mismatch');
    const oriented = image.rotate();
    if (avatar) oriented.resize(512, 512, { fit: 'cover', position: 'attention' });
    buffer = await oriented.webp({ quality: 85 }).toBuffer();
  } catch (_error) {
    throw httpError(422, 'This image could not be read. Choose a valid JPG, PNG, or WebP image.');
  }
  const filename = crypto.randomUUID() + '.webp';
  const options = cloudOptions();
  try {
    if (options) {
      await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ ...options, public_id: publicId(filename),
          overwrite: false, format: 'webp', disable_promise: true }, (error, result) => error ? reject(error) : resolve(result));
        stream.on('error', reject);
        stream.end(buffer);
      });
    } else {
      await fs.mkdir(uploadDir, { recursive: true });
      await fs.writeFile(path.join(uploadDir, filename), buffer);
    }
    return { attachmentPath: filename, attachmentMime: 'image/webp' };
  } catch (_error) {
    await removeImage(filename);
    throw httpError(503, 'Image storage is temporarily unavailable. Please try again.');
  }
}
async function removeImage(filename) {
  if (!filename || !validFilename.test(filename)) return;
  await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
  try {
    const options = cloudOptions();
    if (options) await cloudinary.uploader.destroy(publicId(filename), { ...options, invalidate: true });
  } catch (_error) {
    console.error('Image cleanup failed; Cloudinary may retain an unreferenced protected image.');
  }
}
// Call only after the route has checked the user's access to this image.
async function sendImage(res, filename) {
  if (!filename || !validFilename.test(filename)) throw httpError(404, 'Image was not found.');
  const options = cloudOptions();
  if (!options) return res.type('image/webp').sendFile(path.join(uploadDir, filename));
  try {
    // Existing local images remain usable when Cloudinary is first enabled.
    const local = await fs.readFile(path.join(uploadDir, filename));
    return res.type('image/webp').send(local);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    const url = cloudinary.utils.private_download_url(publicId(filename), 'webp', {
      ...options, expires_at: Math.floor(Date.now() / 1000) + 60, attachment: false
    });
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (response.status === 404) throw httpError(404, 'Image was not found.');
    if (!response.ok) throw new Error('Cloudinary download failed');
    // Never expose the signed URL: every image request keeps its existing access checks.
    return res.type('image/webp').send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    if (error.status === 404) throw error;
    throw httpError(503, 'Image storage is temporarily unavailable. Please try again.');
  }
}
module.exports = { upload, saveImage, removeImage, sendImage, uploadDir };
