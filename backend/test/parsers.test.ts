import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseM3U, buildM3U } from '../src/lib/m3u.ts';
import { parseXmltv, parseXmltvTime } from '../src/lib/xmltv.ts';
import { isPrivateAddress, isSyntacticallySafeUrl, redactUrl, signMediaToken, verifyMediaToken, assertSafeExternalUrl, UnsafeUrlError } from '../src/lib/security.ts';

const SAMPLE_M3U = `#EXTM3U x-tvg-url="https://epg.example.org/guide.xml"
#EXTINF:-1 tvg-id="io.news" tvg-name="IO News" tvg-logo="https://cdn.example.org/news.png" group-title="News",IO News
https://streams.example.org/live/io-news/index.m3u8
#EXTINF:-1 tvg-id="io.sport" group-title="Sports",IO Sport
#EXTVLCOPT:http-user-agent=IOTest/1.0
https://user:secret@streams.example.org/sport.m3u8
#EXTINF:-1 tvg-id="io.news" group-title="News",IO News Duplicate
https://streams.example.org/live/io-news/index.m3u8
#EXTINF:-1,Broken
ftp://files.example.org/x.ts
#EXTINF:-1 tvg-id="io.music" group-title="Music",Music
#EXTGRP:Entertainment
https://streams.example.org/music.m3u8
`;

test('parses EXTINF attributes, groups and EXTGRP', () => {
  const r = parseM3U(SAMPLE_M3U);
  assert.equal(r.channels.length, 5);
  const news = r.channels[0];
  assert.equal(news.title, 'IO News');
  assert.equal(news.tvgId, 'io.news');
  assert.equal(news.tvgName, 'IO News');
  assert.equal(news.tvgLogo, 'https://cdn.example.org/news.png');
  assert.equal(news.groupTitle, 'News');
  assert.equal(news.urlValid, true);
  assert.equal(r.channels[4].extGroup, 'Entertainment');
});

test('strips credentials, records authRequired and keeps VLC user agent', () => {
  const r = parseM3U(SAMPLE_M3U);
  const sport = r.channels[1];
  assert.equal(sport.streamUrl.includes('secret'), false);
  assert.equal(sport.streamUrl.includes('user:'), false);
  assert.equal(sport.authRequired, true);
  assert.equal(sport.attributes['http-user-agent'], 'IOTest/1.0');
});

test('detects duplicates and invalid protocols', () => {
  const r = parseM3U(SAMPLE_M3U);
  assert.equal(r.duplicates, 1);
  assert.equal(r.channels[2].isDuplicate, true);
  assert.equal(r.channels[3].urlValid, false);
  assert.equal(r.invalidUrls, 1);
  assert.ok(r.warnings.some((w) => w.includes('duplicate')));
});

test('handles CRLF and BOM', () => {
  const r = parseM3U('\uFEFF#EXTM3U\r\n#EXTINF:-1 tvg-id="a",A\r\nhttps://a.example.org/a.m3u8\r\n');
  assert.equal(r.channels.length, 1);
  assert.equal(r.channels[0].tvgId, 'a');
});

test('buildM3U produces a parseable round-trip', () => {
  const doc = buildM3U([{ tvgId: 'io.news', name: 'IO News', logo: null, group: 'News', url: 'https://io.example.org/hls/io-news/master.m3u8?token=x' }]);
  assert.match(doc, /^#EXTM3U\n#EXTINF:-1 tvg-id="io.news"/);
  const back = parseM3U(doc);
  assert.equal(back.channels[0].tvgId, 'io.news');
  assert.equal(back.channels[0].groupTitle, 'News');
});

test('XMLTV time parsing with offsets', () => {
  assert.equal(parseXmltvTime('20261031180000 +0300')?.toISOString(), '2026-10-31T15:00:00.000Z');
  assert.equal(parseXmltvTime('20261031180000')?.toISOString(), '2026-10-31T18:00:00.000Z');
  assert.equal(parseXmltvTime('garbage'), null);
});

test('XMLTV document parsing maps channel ids (not names) and counts invalid programmes', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="io.news"><display-name>IO News</display-name></channel>
  <programme start="20261031090000 +0000" stop="20261031100000 +0000" channel="io.news">
    <title lang="en">Morning Brief</title><desc>Headlines &amp; weather</desc><category>News</category>
  </programme>
  <programme start="20261031110000 +0000" stop="20261031100000 +0000" channel="io.news"><title>Bad times</title></programme>
</tv>`;
  const r = parseXmltv(xml);
  assert.equal(r.channels[0].id, 'io.news');
  assert.equal(r.channels[0].displayName, 'IO News');
  assert.equal(r.programs.length, 1);
  assert.equal(r.programs[0].title, 'Morning Brief');
  assert.equal(r.programs[0].description, 'Headlines & weather');
  assert.equal(r.programs[0].category, 'News');
  assert.ok(r.warnings.some((w) => w.includes('skipped')));
});

test('XMLTV rejects non-XMLTV documents', () => {
  assert.throws(() => parseXmltv('<rss></rss>'), /XMLTV/);
});

test('private address detection covers RFC1918, loopback, link-local', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.1.5', '172.16.0.9', '169.254.169.254']) assert.equal(isPrivateAddress(ip), true, ip);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('::1'), true);
});

test('URL protocol validation and SSRF refusal', async () => {
  assert.equal(isSyntacticallySafeUrl('https://a.example.org/x.m3u8'), true);
  assert.equal(isSyntacticallySafeUrl('file:///etc/passwd'), false);
  await assert.rejects(assertSafeExternalUrl('http://127.0.0.1:5250/'), UnsafeUrlError);
  await assert.rejects(assertSafeExternalUrl('http://169.254.169.254/latest/meta-data'), UnsafeUrlError);
  await assert.rejects(assertSafeExternalUrl('http://localhost:8080/'), UnsafeUrlError);
  await assert.rejects(assertSafeExternalUrl('https://u:p@example.org/'), UnsafeUrlError);
});

test('media tokens are signed, verified and expire', () => {
  const t = signMediaToken('io-news', 60, 1_000_000);
  assert.equal(verifyMediaToken('io-news', t, 1_000_000), true);
  assert.equal(verifyMediaToken('other', t, 1_000_000), false);
  assert.equal(verifyMediaToken('io-news', t, 1_000_000 + 61_000), false);
  assert.equal(verifyMediaToken('io-news', undefined), false);
});

test('redactUrl hides secrets in query strings and credentials', () => {
  const r = redactUrl('https://u:p@h.example.org/a.m3u8?token=abc&q=1');
  assert.ok(!r.includes('abc'));
  assert.ok(!r.includes(':p@'));
  assert.ok(r.includes('q=1'));
});
