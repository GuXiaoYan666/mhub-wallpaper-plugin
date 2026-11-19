'use strict';
const http = require('../http.js');
const BASE = 'https://music.163.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://music.163.com/',
  'Accept': 'application/json',
  'Cookie': 'os=pc; appver=2.10.6'
};
const MAX_BODY = 2 * 1024 * 1024;
const META_PREFIX = /^(作词|作曲|编曲|制作人|演唱|歌手|原唱|翻唱|和声|吉他|贝斯|鼓|键盘|钢琴|弦乐|录音|混音|母带|监制|出品|企划|统筹|发行|录音棚|混音室|封面|插画|OP|SP)\s*[:：]/;
function requestJson(url, timeoutMs) {
  return http.requestJson(url, timeoutMs, HEADERS);
}
function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 200);
}
function artistsToText(artists) {
  if (!Array.isArray(artists)) return '';
  return artists.map(function (a) { return a && a.name ? a.name : ''; }).filter(Boolean).join(',');
}
async function searchSongs(track, timeoutMs, withArtist) {
  const title = clean(track && track.title, 120);
  const artist = clean(track && track.artist, 120);
  if (!title) return [];
  const useArtist = withArtist !== false && !!artist;
  const q = useArtist ? (title + ' ' + artist) : title;
  const url = BASE + '/api/search/get?' + encodeURIComponent('s') + '=' + encodeURIComponent(q) +
    '&type=1&limit=50&offset=0';
  const data = await requestJson(url, timeoutMs);
  if (!data || data.code !== 200 || !data.result || !Array.isArray(data.result.songs)) return [];
  const out = [];
  for (let i = 0; i < data.result.songs.length; i++) {
    const s = data.result.songs[i];
    if (!s || !s.id) continue;
    out.push({
      id: String(s.id),
      title: clean(s.name, 160),
      artist: artistsToText(s.artists),
      album: s.album && s.album.name ? clean(s.album.name, 160) : '',
      durationMs: Number(s.duration) || 0
    });
  }
  return out;
}
async function fetchLyrics(songId, timeoutMs) {
  const url = BASE + '/api/song/lyric?id=' + encodeURIComponent(songId) + '&lv=1&kv=1&tv=-1';
  const data = await requestJson(url, timeoutMs);
  if (!data || data.code !== 200) return null;
  if (data.nolyric === true || data.uncollected === true) return { lrc: '', tlyric: '', nolyric: true };
  const lrc = data.lrc && typeof data.lrc.lyric === 'string' ? data.lrc.lyric : '';
  const tlyric = data.tlyric && typeof data.tlyric.lyric === 'string' ? data.tlyric.lyric : '';
  if (!lrc.trim() && !tlyric.trim()) return null;
  return { lrc: lrc, tlyric: tlyric, nolyric: false };
}
async function fetchCover(songId, timeoutMs) {
  const url = BASE + '/api/song/detail?ids=' + encodeURIComponent('[' + songId + ']');
  const data = await requestJson(url, timeoutMs);
  const song = data && data.songs && data.songs[0];
  const pic = song && song.album && typeof song.album.picUrl === 'string' ? song.album.picUrl : '';
  return pic ? pic.replace(/^http:/i, 'https:') : '';
}
const META_WORD = /作词|作曲|编曲|制作|监制|出品|企划|统筹|发行|录音|混音|母带|和声|和音|吉他|贝斯|键盘|钢琴|弦乐|音乐设计|演唱|原唱|翻唱|OP|SP/i;
function isMetaLine(text) {
  const t = clean(text, 80);
  if (META_PREFIX.test(t)) return true;
  const idx = t.search(/[:：]/);
  if (idx > 0 && idx <= 20 && META_WORD.test(t.slice(0, idx))) return true;
  return false;
}
module.exports = {
  searchSongs: searchSongs,
  fetchLyrics: fetchLyrics,
  fetchCover: fetchCover,
  isMetaLine: isMetaLine
};
