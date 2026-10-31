#!/usr/bin/env node
// Generates the IO CasparCG HTML graphics package.
// Output: graphics/templates/io/<slug>/index.html  (CasparCG HTML producer convention:
//   play(), stop(), next(), update(jsonString))
// and graphics/catalog.json, which the backend loads into PostgreSQL (graphics_templates).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.join(here, 'templates', 'io');

const BASE_CSS = `
html,body{margin:0;width:1920px;height:1080px;background:transparent;overflow:hidden;font-family:Inter,"Helvetica Neue",Arial,sans-serif;color:#fff}
.hidden{display:none}
.abs{position:absolute}
.fade{opacity:0;transition:opacity .45s ease,transform .45s cubic-bezier(.2,.8,.2,1)}
.on{opacity:1!important;transform:none!important}
.lbl{font-size:22px;letter-spacing:.18em;text-transform:uppercase;opacity:.85}
.big{font-size:52px;font-weight:700;line-height:1.05}
.mid{font-size:34px;font-weight:500}
`;

function page(id, css, body, script) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>IO ${id}</title>
<style>${BASE_CSS}${css}</style></head>
<body>
${body}
<script>
// CasparCG HTML producer entry points.
var root = document.getElementById('root');
function play(){ root.classList.add('on'); }
function stop(){ root.classList.remove('on'); }
function next(){ }
function setText(id, v){ var el = document.getElementById(id); if (el) el.textContent = (v === undefined || v === null) ? '' : String(v); }
function update(str){
  var d = {};
  try { d = typeof str === 'string' ? JSON.parse(str) : (str || {}); } catch (e) { d = {}; }
  ${script}
}
</script></body></html>`;
}

// ---------- Lower thirds (10 designs) ----------
const LOWER_THIRDS = [
  { n: '01', name: 'Lower Third - Classic Bar', css: '.bar{left:90px;bottom:120px;width:1100px;height:150px;background:rgba(10,10,10,.88);border-left:10px solid #fff;padding:22px 34px;box-sizing:border-box;transform:translateX(-40px)}', pos: 'bar' },
  { n: '02', name: 'Lower Third - Accent Band', css: '.bar{left:90px;bottom:120px;width:1100px;height:150px;background:linear-gradient(90deg,#c8102e,#1a1a1a);padding:22px 34px;box-sizing:border-box;transform:translateY(30px)}', pos: 'bar' },
  { n: '03', name: 'Lower Third - Right Aligned', css: '.bar{right:90px;bottom:120px;width:1000px;height:150px;background:rgba(10,10,10,.9);border-right:10px solid #fff;padding:22px 34px;box-sizing:border-box;text-align:right;transform:translateX(40px)}', pos: 'bar' },
  { n: '04', name: 'Lower Third - Minimal Line', css: '.bar{left:120px;bottom:150px;width:900px;transform:translateY(20px)}.rule{height:4px;background:#fff;width:0;transition:width .6s ease .2s}.on .rule{width:100%}', pos: 'min' },
  { n: '05', name: 'Lower Third - Pill', css: '.bar{left:110px;bottom:130px;background:rgba(15,15,15,.92);border-radius:60px;padding:18px 48px;transform:scale(.96)}', pos: 'pill' },
  { n: '06', name: 'Lower Third - Split Panel', css: '.bar{left:90px;bottom:120px;display:flex;transform:translateX(-30px)}.tag{background:#fff;color:#000;padding:20px 26px;font-weight:800;font-size:30px}.txt{background:rgba(20,20,20,.9);padding:20px 34px}', pos: 'split' },
  { n: '07', name: 'Lower Third - Glass', css: '.bar{left:100px;bottom:120px;width:1050px;background:rgba(255,255,255,.12);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.35);padding:24px 36px;box-sizing:border-box;border-radius:12px;transform:translateY(20px)}', pos: 'bar' },
  { n: '08', name: 'Lower Third - Ticker Tab', css: '.bar{left:0;bottom:90px;width:1920px;height:120px;background:rgba(8,8,8,.92);padding:20px 90px;box-sizing:border-box;border-top:4px solid #fff;transform:translateY(40px)}', pos: 'bar' },
  { n: '09', name: 'Lower Third - Corner Name', css: '.bar{left:80px;bottom:80px;transform:translateX(-20px)}.big{font-size:44px}.mid{font-size:26px;opacity:.9}', pos: 'min' },
  { n: '10', name: 'Lower Third - Dual Line Broadcast', css: '.bar{left:90px;bottom:120px;width:1200px;background:#0b0b0b;transform:translateY(30px)}.l1{background:#fff;color:#000;font-size:40px;font-weight:800;padding:14px 30px}.l2{padding:14px 30px;font-size:30px;color:#ddd}', pos: 'dual' },
];

function lowerThirdHtml(lt) {
  const bodyHtml = lt.pos === 'split'
    ? `<div id="root" class="abs bar fade"><div class="tag" id="name"></div><div class="txt"><div class="mid" id="title"></div></div></div>`
    : lt.pos === 'dual'
      ? `<div id="root" class="abs bar fade"><div class="l1" id="name"></div><div class="l2" id="title"></div></div>`
      : lt.pos === 'min'
        ? `<div id="root" class="abs bar fade"><div class="big" id="name"></div><div class="rule"></div><div class="mid" id="title"></div></div>`
        : `<div id="root" class="abs bar fade"><div class="lbl" id="title"></div><div class="big" id="name"></div></div>`;
  return page(`lower-third-${lt.n}`, lt.css + '.fade{transform:translateY(20px)}.on{transform:none}', bodyHtml,
    `setText('name', d.name); setText('title', d.title);`);
}

// ---------- Breaking news (5 designs) ----------
const BREAKING = [
  { n: '01', name: 'Breaking News - Red Banner', bg: 'linear-gradient(90deg,#b00020,#e10600)', label: 'BREAKING' },
  { n: '02', name: 'Breaking News - Dark Flash', bg: 'linear-gradient(90deg,#111,#2a2a2a)', label: 'LIVE UPDATE' },
  { n: '03', name: 'Breaking News - Stacked', bg: 'linear-gradient(180deg,#e10600,#7a0000)', label: 'BREAKING NEWS' },
  { n: '04', name: 'Breaking News - Split Tag', bg: '#fff', label: 'ALERT', textColor: '#000' },
  { n: '05', name: 'Breaking News - Full Width', bg: 'rgba(0,0,0,.9)', label: 'JUST IN' },
];
function breakingHtml(b) {
  const color = b.textColor ?? '#fff';
  const css = `.bn{left:0;bottom:200px;width:1920px;box-sizing:border-box;padding:24px 90px;background:${b.bg};color:${color};transform:translateY(60px)}
  .tag{display:inline-block;background:#fff;color:#000;font-weight:900;font-size:26px;letter-spacing:.12em;padding:6px 14px;margin-bottom:12px}`;
  return page(`breaking-news-${b.n}`, css, `<div id="root" class="abs bn fade"><span class="tag" id="label">${b.label}</span><div class="big" id="headline"></div><div class="mid" id="sub"></div></div>`,
    `setText('label', d.label || '${b.label}'); setText('headline', d.headline); setText('sub', d.subline);`);
}

// ---------- Other single-purpose designs ----------
const OTHER = [
  {
    slug: 'news-ticker', name: 'News Ticker', category: 'Tickers', description: 'Bottom ticker with label and scrolling headlines',
    fields: [{ key: 'label', label: 'Label' }, { key: 'text', label: 'Headlines (separate with •)' }],
    css: `.tk{left:0;bottom:0;width:1920px;height:96px;background:rgba(5,5,5,.95);border-top:3px solid #fff;display:flex;align-items:center;overflow:hidden}
    .lab{background:#fff;color:#000;font-weight:900;font-size:34px;padding:0 40px;height:100%;display:flex;align-items:center}
    .scroll{white-space:nowrap;font-size:40px;padding-left:40px;animation:scroll 22s linear infinite}
    @keyframes scroll{from{transform:translateX(1920px)}to{transform:translateX(-100%)}}`,
    body: `<div id="root" class="abs tk fade"><div class="lab" id="label"></div><div class="scroll" id="text"></div></div>`,
    script: `setText('label', d.label||'NEWS'); setText('text', d.text||'');`,
  },
  {
    slug: 'scrolling-crawl', name: 'Scrolling Crawl', category: 'Tickers', description: 'Full-width scrolling text crawl',
    fields: [{ key: 'text', label: 'Crawl text' }],
    css: `.cr{left:0;top:0;width:1920px;height:1080px;background:linear-gradient(#000,#0a1a33);overflow:hidden;perspective:600px}
    .txt{position:absolute;left:160px;right:160px;bottom:-900px;font-size:58px;line-height:1.35;text-align:justify;transform-origin:50% 100%;transform:rotateX(25deg)}
    .on .txt{animation:crawl 40s linear forwards}
    @keyframes crawl{to{bottom:1400px}}`,
    body: `<div id="root" class="abs cr fade"><div class="txt" id="text"></div></div>`,
    script: `setText('text', d.text||'');`,
  },
  {
    slug: 'digital-clock', name: 'Digital Clock', category: 'Utility', description: 'Live clock (uses the server-side render clock)',
    fields: [{ key: 'label', label: 'Label (optional)' }],
    css: `.clk{right:90px;top:70px;background:rgba(0,0,0,.8);padding:18px 30px;border:2px solid #fff}
    .time{font-size:78px;font-weight:700;font-variant-numeric:tabular-nums}`,
    body: `<div id="root" class="abs clk fade"><div class="lbl" id="label"></div><div class="time" id="time">00:00:00</div></div>`,
    script: `setText('label', d.label||''); tick();`,
    extraScript: `function tick(){ var t=new Date(); var p=function(n){return (n<10?'0':'')+n}; setText('time', p(t.getHours())+':'+p(t.getMinutes())+':'+p(t.getSeconds())); }
    setInterval(tick, 250);`,
  },
  {
    slug: 'countdown-timer', name: 'Countdown Timer', category: 'Utility', description: 'Counts down to a target ISO 8601 time',
    fields: [{ key: 'target', label: 'Target (ISO 8601)' }, { key: 'label', label: 'Label' }],
    css: `.cd{right:90px;top:70px;background:rgba(0,0,0,.85);padding:20px 34px;border-left:8px solid #e10600}
    .time{font-size:84px;font-weight:800;font-variant-numeric:tabular-nums}`,
    body: `<div id="root" class="abs cd fade"><div class="lbl" id="label"></div><div class="time" id="time">--:--:--</div></div>`,
    script: `setText('label', d.label||''); target = d.target ? Date.parse(d.target) : NaN; tickCd();`,
    extraScript: `var target = NaN; function tickCd(){ if (isNaN(target)) { setText('time','--:--:--'); return; } var s=Math.max(0,Math.floor((target-Date.now())/1000)); var p=function(n){return (n<10?'0':'')+n}; setText('time', p(Math.floor(s/3600))+':'+p(Math.floor(s%3600/60))+':'+p(s%60)); }
    setInterval(tickCd, 250);`,
  },
  {
    slug: 'general-scoreboard', name: 'General Scoreboard', category: 'Scoreboards', description: 'Two-team score bug',
    fields: [{ key: 'home', label: 'Home team' }, { key: 'homeScore', label: 'Home score' }, { key: 'away', label: 'Away team' }, { key: 'awayScore', label: 'Away score' }, { key: 'period', label: 'Period / status' }],
    css: `.sb{left:50%;top:50px;transform:translateX(-50%);display:flex;background:#0d0d0d;border:2px solid #fff;font-size:44px;font-weight:700}
    .team{padding:18px 34px;min-width:260px}.score{background:#fff;color:#000;padding:18px 26px;min-width:96px;text-align:center}
    .per{background:#222;padding:18px 26px;font-size:28px;display:flex;align-items:center}`,
    body: `<div id="root" class="abs sb fade"><div class="team" id="home"></div><div class="score" id="hs"></div><div class="per" id="period"></div><div class="score" id="as"></div><div class="team" id="away" style="text-align:right"></div></div>`,
    script: `setText('home', d.home); setText('hs', d.homeScore); setText('away', d.away); setText('as', d.awayScore); setText('period', d.period);`,
  },
  {
    slug: 'football-scoreboard', name: 'Football (American) Scoreboard', category: 'Scoreboards', description: 'Score, quarter and possession',
    fields: [{ key: 'home', label: 'Home' }, { key: 'homeScore', label: 'Home pts' }, { key: 'away', label: 'Away' }, { key: 'awayScore', label: 'Away pts' }, { key: 'period', label: 'Quarter / clock' }, { key: 'possession', label: 'Possession (home|away)' }],
    css: `.sb{left:50%;top:50px;transform:translateX(-50%);background:linear-gradient(90deg,#0b3d91,#111);border-bottom:6px solid #ffb400;font-size:42px;font-weight:700;display:flex;align-items:stretch}
    .t{padding:16px 30px;min-width:240px;display:flex;align-items:center;gap:14px}.s{font-size:58px;padding:12px 26px;min-width:90px;text-align:center}
    .poss{width:14px;height:14px;background:#ffb400;border-radius:50%;opacity:0}.poss.on{opacity:1}.q{background:#000;padding:16px 28px;font-size:30px;display:flex;align-items:center;flex-direction:column;justify-content:center}`,
    body: `<div id="root" class="abs sb fade"><div class="t"><span class="poss" id="ph"></span><span id="home"></span></div><div class="s" id="hs"></div><div class="q" id="period"></div><div class="s" id="as"></div><div class="t" style="justify-content:flex-end"><span id="away"></span><span class="poss" id="pa"></span></div></div>`,
    script: `setText('home', d.home); setText('hs', d.homeScore); setText('away', d.away); setText('as', d.awayScore); setText('period', d.period); document.getElementById('ph').className='poss'+(d.possession==='home'?' on':''); document.getElementById('pa').className='poss'+(d.possession==='away'?' on':'');`,
  },
  {
    slug: 'basketball-scoreboard', name: 'Basketball Scoreboard', category: 'Scoreboards', description: 'Score, quarter and fouls',
    fields: [{ key: 'home', label: 'Home' }, { key: 'homeScore', label: 'Home pts' }, { key: 'homeFouls', label: 'Home fouls' }, { key: 'away', label: 'Away' }, { key: 'awayScore', label: 'Away pts' }, { key: 'awayFouls', label: 'Away fouls' }, { key: 'period', label: 'Quarter' }],
    css: `.sb{left:50%;bottom:60px;transform:translateX(-50%);background:#101010;border-radius:14px;overflow:hidden;font-size:40px;font-weight:700;display:flex;border:2px solid #f57c00}
    .t{padding:16px 30px;min-width:260px}.s{background:#f57c00;color:#000;font-size:64px;padding:12px 28px;min-width:110px;text-align:center}
    .q{padding:16px 24px;font-size:28px;background:#1d1d1d;display:flex;align-items:center}.f{font-size:22px;opacity:.7;font-weight:500}`,
    body: `<div id="root" class="abs sb fade"><div class="t"><div id="home"></div><div class="f" id="hf"></div></div><div class="s" id="hs"></div><div class="q" id="period"></div><div class="s" id="as"></div><div class="t" style="text-align:right"><div id="away"></div><div class="f" id="af"></div></div></div>`,
    script: `setText('home', d.home); setText('hs', d.homeScore); setText('hf', d.homeFouls ? 'Fouls '+d.homeFouls : ''); setText('away', d.away); setText('as', d.awayScore); setText('af', d.awayFouls ? 'Fouls '+d.awayFouls : ''); setText('period', d.period);`,
  },
  {
    slug: 'soccer-scoreboard', name: 'Soccer Scoreboard', category: 'Scoreboards', description: 'Score, match minute and scorers',
    fields: [{ key: 'home', label: 'Home' }, { key: 'homeScore', label: 'Home goals' }, { key: 'away', label: 'Away' }, { key: 'awayScore', label: 'Away goals' }, { key: 'minute', label: 'Minute (e.g. 67\')' }, { key: 'scorers', label: 'Scorers (optional)' }],
    css: `.sb{left:50%;top:50px;transform:translateX(-50%);background:linear-gradient(#0e7a2f,#0a5a22);border:2px solid #fff;border-radius:6px;overflow:hidden;font-size:40px;font-weight:700;display:flex;flex-direction:column;min-width:900px}
    .row{display:flex;align-items:center}.t{flex:1;padding:14px 26px}.s{background:#fff;color:#0a5a22;padding:12px 26px;min-width:90px;text-align:center;font-size:56px}
    .min{background:#000;padding:10px;text-align:center;font-size:26px;letter-spacing:.1em}.sc{font-size:22px;padding:8px 26px;opacity:.9;text-align:center;font-weight:500}`,
    body: `<div id="root" class="abs sb fade"><div class="row"><div class="t" id="home"></div><div class="s" id="hs"></div><div class="s" id="as"></div><div class="t" id="away" style="text-align:right"></div></div><div class="min" id="minute"></div><div class="sc" id="scorers"></div></div>`,
    script: `setText('home', d.home); setText('hs', d.homeScore); setText('away', d.away); setText('as', d.awayScore); setText('minute', d.minute); setText('scorers', d.scorers);`,
  },
  {
    slug: 'weather-panel', name: 'Weather Panel', category: 'Weather', description: 'City, temperature and condition',
    fields: [{ key: 'city', label: 'City' }, { key: 'temp', label: 'Temperature (e.g. 18°C)' }, { key: 'condition', label: 'Condition' }, { key: 'detail', label: 'Detail (wind, humidity)' }],
    css: `.wx{left:90px;bottom:120px;width:760px;background:linear-gradient(120deg,rgba(20,60,120,.9),rgba(10,10,10,.9));padding:28px 36px;box-sizing:border-box;border-radius:10px}
    .temp{font-size:150px;font-weight:300;line-height:1}.cond{font-size:36px}`,
    body: `<div id="root" class="abs wx fade"><div class="lbl" id="city"></div><div class="temp" id="temp"></div><div class="cond" id="condition"></div><div class="mid" id="detail" style="opacity:.8;font-size:26px"></div></div>`,
    script: `setText('city', d.city); setText('temp', d.temp); setText('condition', d.condition); setText('detail', d.detail);`,
  },
  {
    slug: 'election-results', name: 'Election Results', category: 'Elections', description: 'Up to four candidates with live vote shares',
    fields: [{ key: 'race', label: 'Race title' }, { key: 'reporting', label: 'Reporting (e.g. 62% counted)' }, { key: 'c1', label: 'Candidate 1 (name|party|pct|color)' }, { key: 'c2', label: 'Candidate 2' }, { key: 'c3', label: 'Candidate 3 (optional)' }, { key: 'c4', label: 'Candidate 4 (optional)' }],
    css: `.el{left:90px;bottom:120px;width:1100px;background:rgba(8,8,8,.92);padding:24px 30px;box-sizing:border-box;border-top:6px solid #fff}
    .row{display:flex;align-items:center;gap:20px;font-size:32px;margin-top:12px}.bar{flex:1;height:26px;background:#222;position:relative}.fill{height:100%;position:absolute;left:0;top:0}
    .pct{width:120px;text-align:right;font-weight:700}`,
    body: `<div id="root" class="abs el fade"><div class="big" id="race"></div><div class="lbl" id="reporting"></div><div id="rows"></div></div>`,
    script: `setText('race', d.race); setText('reporting', d.reporting); var h=''; ['c1','c2','c3','c4'].forEach(function(k){ if(!d[k]) return; var p=String(d[k]).split('|'); var pct=Math.max(0,Math.min(100,Number(p[2])||0)); h+='<div class="row"><div style="width:360px">'+(p[0]||'')+' <span class="lbl">'+(p[1]||'')+'</span></div><div class="bar"><div class="fill" style="width:'+pct+'%;background:'+(p[3]||'#fff')+'"></div></div><div class="pct">'+pct.toFixed(1)+'%</div></div>'; }); document.getElementById('rows').innerHTML=h;`,
  },
  {
    slug: 'logo-animation', name: 'Logo Animation', category: 'Branding', description: 'Animated logo reveal with wordmark',
    fields: [{ key: 'wordmark', label: 'Wordmark' }, { key: 'tagline', label: 'Tagline' }, { key: 'logoUrl', label: 'Logo image URL (optional)' }],
    css: `.lg{left:0;top:0;width:1920px;height:1080px;display:flex;align-items:center;justify-content:center;flex-direction:column}
    .mark{width:220px;height:220px;border:10px solid #fff;border-radius:50%;transform:scale(0) rotate(-180deg);transition:transform 1s cubic-bezier(.2,.9,.3,1.3)}
    .on .mark{transform:scale(1) rotate(0)}.word{font-size:110px;font-weight:800;letter-spacing:.06em;opacity:0;transform:translateY(20px);transition:all .8s .6s}
    .on .word{opacity:1;transform:none}.tag{font-size:34px;letter-spacing:.3em;opacity:0;transition:opacity .8s 1.2s}.on .tag{opacity:.9}`,
    body: `<div id="root" class="abs lg fade" style="transition:opacity .4s"><div class="mark"></div><div class="word" id="word"></div><div class="tag" id="tag"></div></div>`,
    script: `setText('word', d.wordmark||'IO'); setText('tag', d.tagline||'');`,
  },
  {
    slug: 'program-introduction', name: 'Program Introduction', category: 'Programs', description: 'Opening card with show title and presenter',
    fields: [{ key: 'title', label: 'Show title' }, { key: 'subtitle', label: 'Subtitle / episode' }, { key: 'presenter', label: 'Presenter' }],
    css: `.pi{left:0;top:0;width:1920px;height:1080px;background:radial-gradient(circle at 30% 40%,#2b2b2b,#000 70%);display:flex;flex-direction:column;justify-content:center;padding:0 160px;box-sizing:border-box}
    .ttl{font-size:150px;font-weight:800;line-height:1;transform:translateX(-80px);transition:transform 1s ease}.on .ttl{transform:none}
    .sub{font-size:48px;margin-top:24px;opacity:0;transition:opacity 1s .5s}.on .sub{opacity:.9}.pre{font-size:34px;margin-top:40px;letter-spacing:.2em;text-transform:uppercase;opacity:0;transition:opacity 1s 1s}.on .pre{opacity:.85}`,
    body: `<div id="root" class="abs pi fade"><div class="lbl">Now on IO</div><div class="ttl" id="title"></div><div class="sub" id="subtitle"></div><div class="pre" id="presenter"></div></div>`,
    script: `setText('title', d.title); setText('subtitle', d.subtitle); setText('presenter', d.presenter ? 'With '+d.presenter : '');`,
  },
  {
    slug: 'program-transition', name: 'Program Transition', category: 'Programs', description: 'Full-screen wipe transition card with next program title',
    fields: [{ key: 'upNext', label: 'Up next label' }, { key: 'title', label: 'Next program' }],
    css: `.pt{left:0;top:0;width:1920px;height:1080px;background:#000;display:flex;align-items:center;justify-content:center;flex-direction:column;clip-path:inset(0 100% 0 0);transition:clip-path .9s cubic-bezier(.7,0,.2,1)}
    .on.pt{clip-path:inset(0 0 0 0)}.big{font-size:120px}`,
    body: `<div id="root" class="abs pt"><div class="lbl" id="upNext"></div><div class="big" id="title"></div></div>`,
    script: `setText('upNext', d.upNext||'UP NEXT'); setText('title', d.title);`,
  },
  {
    slug: 'end-credits', name: 'End Credits', category: 'Programs', description: 'Scrolling credits from newline-separated lines',
    fields: [{ key: 'lines', label: 'Credit lines (separate with |)' }],
    css: `.ec{left:0;top:0;width:1920px;height:1080px;background:#000;overflow:hidden}
    .list{position:absolute;left:0;right:0;top:1080px;text-align:center;font-size:44px;line-height:1.7}
    .on .list{animation:roll 30s linear forwards}@keyframes roll{to{top:-1800px}}`,
    body: `<div id="root" class="abs ec fade"><div class="list" id="list"></div></div>`,
    script: `var h=''; String(d.lines||'').split('|').forEach(function(l){ h+='<div>'+l.replace(/</g,'&lt;')+'</div>'; }); document.getElementById('list').innerHTML=h;`,
  },
];

function writeTemplate(slug, html) {
  const dir = path.join(outRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
}

const catalog = [];
for (const lt of LOWER_THIRDS) {
  const slug = `lower-third-${lt.n}`;
  writeTemplate(slug, lowerThirdHtml(lt));
  catalog.push({ slug, name: lt.name, category: 'Lower Thirds', description: 'Name and title caption', templatePath: `io/${slug}/index.html`, fields: [{ key: 'name', label: 'Name' }, { key: 'title', label: 'Title / role' }] });
}
for (const b of BREAKING) {
  const slug = `breaking-news-${b.n}`;
  writeTemplate(slug, breakingHtml(b));
  catalog.push({ slug, name: b.name, category: 'Breaking News', description: 'Breaking news banner', templatePath: `io/${slug}/index.html`, fields: [{ key: 'label', label: 'Label' }, { key: 'headline', label: 'Headline' }, { key: 'subline', label: 'Sub-line' }] });
}
for (const o of OTHER) {
  const extra = o.extraScript ?? '';
  const html = page(o.slug, o.css, o.body, o.script).replace('</script></body>', `${extra}\n</script></body>`);
  writeTemplate(o.slug, html);
  catalog.push({ slug: o.slug, name: o.name, category: o.category, description: o.description, templatePath: `io/${o.slug}/index.html`, fields: o.fields });
}

fs.writeFileSync(path.join(here, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ level: 'INFO', msg: 'graphics package generated', templates: catalog.length, categories: [...new Set(catalog.map((c) => c.category))] }));
