from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SCALE = 4


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient(
    size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]
) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pixels = image.load()
    assert pixels is not None
    for y in range(size):
        for x in range(size):
            t = min(1.0, max(0.0, (x * 0.38 + y * 0.62) / size))
            pixels[x, y] = (
                lerp(top[0], bottom[0], t),
                lerp(top[1], bottom[1], t),
                lerp(top[2], bottom[2], t),
                255,
            )
    return image


def create_icon(size: int, dark: bool = False) -> Image.Image:
    canvas_size = size * SCALE
    margin = round(canvas_size * 0.045)
    radius = round(canvas_size * 0.25)
    base = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))

    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        (
            margin,
            margin + canvas_size * 0.025,
            canvas_size - margin,
            canvas_size - margin,
        ),
        radius=radius,
        fill=(4, 8, 28, 120),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(canvas_size * 0.035))
    base.alpha_composite(shadow)

    mask = Image.new("L", base.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(
        (margin, margin, canvas_size - margin, canvas_size - margin),
        radius=radius,
        fill=255,
    )
    colors = (
        ((20, 27, 66), (65, 84, 246))
        if not dark
        else ((27, 35, 83), (79, 99, 255))
    )
    fill = gradient(canvas_size, *colors)
    fill.putalpha(mask)
    base.alpha_composite(fill)

    draw = ImageDraw.Draw(base)
    border = max(1, round(canvas_size * 0.018))
    draw.rounded_rectangle(
        (
            margin + border / 2,
            margin + border / 2,
            canvas_size - margin - border / 2,
            canvas_size - margin - border / 2,
        ),
        radius=radius - border / 2,
        outline=(143, 158, 255, 150),
        width=border,
    )

    center = canvas_size / 2
    ring_radius = canvas_size * 0.30
    ring_width = max(1, round(canvas_size * 0.017))
    draw.ellipse(
        (
            center - ring_radius,
            center - ring_radius,
            center + ring_radius,
            center + ring_radius,
        ),
        outline=(188, 196, 255, 100),
        width=ring_width,
    )

    node_radius = canvas_size * 0.043
    nodes = [
        (center, center - ring_radius),
        (center - ring_radius * 0.86, center + ring_radius * 0.50),
        (center + ring_radius * 0.86, center + ring_radius * 0.50),
    ]
    for x, y in nodes:
        draw.ellipse(
            (x - node_radius, y - node_radius, x + node_radius, y + node_radius),
            fill=(248, 207, 99, 255),
            outline=(255, 242, 170, 255),
            width=max(1, round(canvas_size * 0.008)),
        )

    bolt = [
        (center + canvas_size * 0.055, center - canvas_size * 0.31),
        (center - canvas_size * 0.16, center + canvas_size * 0.04),
        (center - canvas_size * 0.015, center + canvas_size * 0.04),
        (center - canvas_size * 0.065, center + canvas_size * 0.31),
        (center + canvas_size * 0.16, center - canvas_size * 0.055),
        (center + canvas_size * 0.015, center - canvas_size * 0.055),
    ]
    draw.polygon(bolt, fill=(247, 195, 72, 255))
    draw.line(
        [(x, y - canvas_size * 0.012) for x, y in bolt[:3]],
        fill=(255, 246, 188, 235),
        width=max(1, round(canvas_size * 0.012)),
        joint="curve",
    )

    return base.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    create_icon(128).save(ASSETS / "composer-icon.png", optimize=True)
    create_icon(512).save(ASSETS / "logo.png", optimize=True)
    create_icon(512, dark=True).save(ASSETS / "logo-dark.png", optimize=True)
    create_icon(24).save(ASSETS / "icon-24.png", optimize=True)


if __name__ == "__main__":
    main()
