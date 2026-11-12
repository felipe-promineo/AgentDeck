// Builds the phone app's web files into www/ (what Capacitor puts in the
// Android app, and what the relay can serve as a web page):
//   src/                      the phone's own files
//   ../src/renderer/…         the desktop app's chat and Hub code and styles, unchanged
//   ../node_modules/…         the libraries and fonts the desktop app uses
// Run: npm run build (in mobile/), or node mobile/build.js.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'www');
const nm = path.join(root, 'node_modules');

const RENDERER = ['styles.css', 'theme-mother.css', 'theme-light.css', 'theme.js', 'diffview.js', 'umlview.js', 'boxcard.js',
  'sounds.js', 'render.js', 'imagereview.js', 'hub.js', 'tasktype.js', 'mirror.js'];

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function copyDir(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
    else copy(path.join(from, e.name), path.join(to, e.name));
  }
}

if (!fs.existsSync(path.join(nm, 'marked'))) {
  console.error('Run npm install in the repository folder first (the phone app uses its libraries).');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
copyDir(path.join(__dirname, 'src'), out);
for (const f of RENDERER) copy(path.join(root, 'src', 'renderer', f), path.join(out, 'renderer', f));
copyDir(path.join(root, 'src', 'renderer', 'fonts'), path.join(out, 'renderer', 'fonts'));

// The fonts: each weight's CSS, with the font files next to it.
for (const [pkg, weights] of [['nunito', [400, 500, 600, 700, 800]], ['fira-code', [400, 500, 600]]]) {
  for (const w of weights) copy(path.join(nm, '@fontsource', pkg, `${w}.css`), path.join(out, 'fonts', `${pkg}-${w}.css`));
  copyDir(path.join(nm, '@fontsource', pkg, 'files'), path.join(out, 'fonts', 'files'));
}
copy(path.join(nm, 'marked', 'lib', 'marked.umd.js'), path.join(out, 'lib', 'marked.umd.js'));
copy(path.join(nm, 'dompurify', 'dist', 'purify.min.js'), path.join(out, 'lib', 'purify.min.js'));
copy(path.join(nm, '@highlightjs', 'cdn-assets', 'highlight.min.js'), path.join(out, 'lib', 'highlight.min.js'));
copy(path.join(nm, '@highlightjs', 'cdn-assets', 'styles', 'github-dark-dimmed.min.css'), path.join(out, 'lib', 'github-dark-dimmed.min.css'));
copy(path.join(root, 'build', 'icon.png'), path.join(out, 'icon.png'));

// Push notifications need Firebase, which needs google-services.json in the Android app.
const push = fs.existsSync(path.join(__dirname, 'android', 'app', 'google-services.json'));
fs.writeFileSync(path.join(out, 'config.js'), `window.PHONE_PUSH = ${push};\n`);
const html = path.join(out, 'index.html');
fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<script src="connection.js">', '<script src="config.js"></script>\n  <script src="connection.js">'));

console.log(`Built ${path.relative(root, out)}${push ? ' (with push notifications)' : ''}`);
