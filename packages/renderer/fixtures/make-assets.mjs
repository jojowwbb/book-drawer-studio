import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));

function solid(name, w, h, [r, g, b, a]) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (w * y + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }
  writeFileSync(join(dir, name), PNG.sync.write(png));
}

solid('bg.png', 16, 9, [30, 42, 74, 255]);
solid('subject-a.png', 8, 8, [239, 111, 108, 255]);
solid('subject-b.png', 8, 8, [255, 209, 102, 255]);
solid('fg.png', 16, 3, [20, 28, 48, 255]);
console.log('fixture assets written');
