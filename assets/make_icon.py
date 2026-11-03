"""Terrible Trio server icon: three devils on a fiery radial gradient."""
import math
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

S = 1024
here = sys.argv[1]


def radial(size, inner, outer):
    img = Image.new("RGB", (size, size))
    px = img.load()
    c = size / 2
    for y in range(size):
        for x in range(size):
            t = min(1.0, math.hypot(x - c, (y - c) * 1.05 - size * 0.08) / (size * 0.72))
            t = t ** 1.3
            px[x, y] = tuple(int(inner[i] + (outer[i] - inner[i]) * t) for i in range(3))
    return img


bg = radial(S, (255, 140, 40), (120, 0, 40)).convert("RGBA")
devil = Image.open(f"{here}/devil.png").convert("RGBA")


def place(canvas, img, size, cx, cy, dim=1.0, shadow=True):
    im = img.resize((size, size), Image.LANCZOS)
    if dim != 1.0:
        im = ImageEnhance.Brightness(im).enhance(dim)
    if shadow:
        pad = size // 4  # room for the blur, so the shadow doesn't clip into a rectangle
        alpha = Image.new("L", (size + 2 * pad, size + 2 * pad), 0)
        alpha.paste(im.getchannel("A").point(lambda a: int(a * 0.6)), (pad, pad))
        sh = Image.new("RGBA", alpha.size, (30, 0, 10, 255))
        sh.putalpha(alpha.filter(ImageFilter.GaussianBlur(size // 16)))
        canvas.alpha_composite(sh, (cx - size // 2 - pad + size // 30, cy - size // 2 - pad + size // 16))
    canvas.alpha_composite(im, (cx - size // 2, cy - size // 2))


# two sidekicks behind, the leader in front
place(bg, devil.transpose(Image.FLIP_LEFT_RIGHT), 430, 300, 590, dim=0.75)
place(bg, devil, 430, S - 300, 590, dim=0.75)
place(bg, devil, 600, S // 2, 520)

# soft vignette so the edges read at tiny sizes
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).ellipse((-S * 0.15, -S * 0.15, S * 1.15, S * 1.15), fill=255)
mask = mask.filter(ImageFilter.GaussianBlur(S // 10))
dark = Image.new("RGBA", (S, S), (40, 0, 20, 255))
icon = Image.composite(bg, dark, mask)

icon = icon.resize((512, 512), Image.LANCZOS)
icon.save(f"{here}/terrible_trio.png")
for px in (128, 48):
    icon.resize((px, px), Image.LANCZOS).save(f"{here}/preview_{px}.png")
print("ok")
