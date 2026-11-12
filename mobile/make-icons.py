# Makes the Android app's icons and splash screens from build/icon.png
# (the desktop app's icon). Run after changing that icon: python3 make-icons.py
from PIL import Image
import glob, os

here = os.path.dirname(os.path.abspath(__file__))
res = os.path.join(here, 'android', 'app', 'src', 'main', 'res')
icon = Image.open(os.path.join(here, '..', 'build', 'icon.png')).convert('RGBA')
BG = (31, 25, 19, 255)   # the app's background, #1f1913
sizes = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}

for d, k in sizes.items():
    legacy = round(48 * k)
    for name in ('ic_launcher.png', 'ic_launcher_round.png'):
        icon.resize((legacy, legacy), Image.LANCZOS).save(os.path.join(res, f'mipmap-{d}', name))
    # Adaptive icon: 108 dp with the picture inside the 72 dp safe zone.
    full = round(108 * k)
    inner = round(76 * k)
    fg = Image.new('RGBA', (full, full), (0, 0, 0, 0))
    fg.paste(icon.resize((inner, inner), Image.LANCZOS), ((full - inner) // 2, (full - inner) // 2))
    fg.save(os.path.join(res, f'mipmap-{d}', 'ic_launcher_foreground.png'))

with open(os.path.join(res, 'values', 'ic_launcher_background.xml'), 'w') as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#1F1913</color>\n</resources>\n')

for path in glob.glob(os.path.join(res, 'drawable*', 'splash.png')):
    w, h = Image.open(path).size
    s = Image.new('RGBA', (w, h), BG)
    side = round(min(w, h) * 0.28)
    s.paste(icon.resize((side, side), Image.LANCZOS), ((w - side) // 2, (h - side) // 2), icon.resize((side, side), Image.LANCZOS))
    s.convert('RGB').save(path)
print('icons and splash screens written')
