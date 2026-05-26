'use strict';

/**
 * shared/brand.js — загружает фирменный стиль из config/brand/brand.json.
 * Если файл отсутствует — работает на fallback-значениях без падения.
 */

const path = require('path');
const fs   = require('fs');
const { createLogger } = require('./logger');

const BRAND_PATH = path.join(__dirname, '../config/brand/brand.json');

const FALLBACK = {
  name: 'AcroGym',
  colors: {
    primary_blue:   '#28347F',
    primary_orange: '#F37021',
    white:          '#FFFFFF',
  },
  fonts: {
    heading: { name: 'Montserrat', weight: '800', fallback: 'sans-serif' },
    body:    { name: 'Montserrat', weight: '400', fallback: 'sans-serif' },
  },
  chart_palette: {
    primary:    '#28347F',
    secondary:  '#F37021',
    background: '#FFFFFF',
    grid:       '#E5E5E5',
    text:       '#28347F',
    series:     ['#28347F', '#F37021', '#5A6BC4', '#FF9755', '#1A2356', '#C25617'],
  },
};

let _brand      = null;
let _onFallback = false;

/**
 * Returns the brand config object.
 * Loads from disk on first call, cached thereafter.
 */
function getBrand() {
  if (_brand) return _brand;

  try {
    _brand      = JSON.parse(fs.readFileSync(BRAND_PATH, 'utf8'));
    _onFallback = false;
  } catch {
    createLogger('brand').warn(
      { path: BRAND_PATH },
      'brand.json not found or invalid — using fallback brand config'
    );
    _brand      = FALLBACK;
    _onFallback = true;
  }

  return _brand;
}

/** True if running on fallback (brand.json missing). */
function isOnFallback() {
  if (!_brand) getBrand();
  return _onFallback;
}

module.exports = { getBrand, isOnFallback };
