'use strict';
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { httpError } = require('../utils/validation');
const uploadDir = path.resolve(__dirname, '../../public/uploads');
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
  let filename;
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
    filename = crypto.randomUUID() + '.webp';
    await fs.mkdir(uploadDir, { recursive: true });
    const oriented = image.rotate();
    if (avatar) oriented.resize(512, 512, { fit: 'cover', position: 'attention' });
    await oriented.webp({ quality: 85 }).toFile(path.join(uploadDir, filename));
    return { attachmentPath: filename, attachmentMime: 'image/webp' };
  } catch (_error) {
    await removeImage(filename);
    throw httpError(422, 'This image could not be read. Choose a valid JPG, PNG, or WebP image.');
  }
}
async function removeImage(filename) {
  if (filename && /^[a-f0-9-]+\.webp$/.test(filename)) await fs.unlink(path.join(uploadDir, filename)).catch(() => {});
}
module.exports = { upload, saveImage, removeImage, uploadDir };
