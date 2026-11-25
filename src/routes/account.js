'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { upload, saveImage, removeImage, sendImage } = require('../services/uploads');
const { httpError } = require('../utils/validation');

function accountRoutes(store) {
  const router = express.Router();
  const render = (req, res, extra = {}) => res.render('account/profile', {
    title: 'My account', active: 'account', values: { name: req.user.name }, ...extra
  });

  router.get('/account', requireAuth, (req, res) => render(req, res));
  router.post('/account/profile', requireAuth, upload, async (req, res, next) => {
    let image;
    try {
      const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
      if (!name || [...name].length > 200) {
        return render(req, res.status(422), { values: { name }, flash: { type: 'error', message: 'Enter your full name using 1 to 200 characters.' } });
      }
      let avatarUrl;
      if (req.file) {
        image = await saveImage(req.file, { avatar: true });
        avatarUrl = '/avatars/' + image.attachmentPath;
      } else if (req.body.removePhoto === '1') avatarUrl = null;
      await store.updateProfile(req.user.id, { name, avatarUrl });
      if (avatarUrl !== undefined && /^\/avatars\/[a-f0-9-]+\.webp$/.test(req.user.avatar_url || '')) {
        await removeImage(req.user.avatar_url.slice('/avatars/'.length));
      }
      req.session.flash = { type: 'success', message: 'Your profile has been updated.' };
      res.redirect('/account');
    } catch (error) {
      if (image) await removeImage(image.attachmentPath);
      if (error.status === 422) return render(req, res.status(422), {
        values: { name: typeof req.body.name === 'string' ? req.body.name : req.user.name },
        flash: { type: 'error', message: error.message }
      });
      next(error);
    }
  });

  router.get('/avatars/:filename', requireAuth, async (req, res) => {
    const filename = req.params.filename;
    if (!/^[a-f0-9-]+\.webp$/.test(filename) || !await store.profilePhotoExists(filename)) {
      throw httpError(404, 'Profile photo was not found.');
    }
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', 'inline; filename="profile-photo.webp"');
    await sendImage(res, filename);
  });
  return router;
}
module.exports = { accountRoutes };
