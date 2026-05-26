'use strict';

/**
 * Абстракция канала уведомлений.
 * В будущем часть каналов может переехать на WhatsApp Cloud API —
 * менять только этот файл.
 */
const {
  sendToAdmin,
  sendToOwner,
  sendPhotoToOwner,
  sendMediaGroupToOwner,
} = require('./telegram');

module.exports = {
  sendToAdmin,
  sendToOwner,
  sendPhotoToOwner,
  sendMediaGroupToOwner,
};
