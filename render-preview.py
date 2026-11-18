"""Draw the AIRCORE catalog thumbnail from a synthetic mixer layout."""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def render(*, cover=False):
    image = Image.new("RGB", (640, 480), "#080808")
    draw = ImageDraw.Draw(image)
    font_dir = Path("C:/Windows/Fonts")

    def text(x, y, value, size, color="#d5d6d6", bold=False):
        font = ImageFont.truetype(str(font_dir / ("arialbd.ttf" if bold else "arial.ttf")), size)
        draw.text((x, y), value, font=font, fill=color, anchor="mm")

    def key(box, label, fill="#3c3d3e", color="#d5d6d6", size=11):
        draw.rectangle(box, fill=fill, outline="#565858")
        text((box[0] + box[2]) / 2, (box[1] + box[3]) / 2, label, size, color, True)

    accent = "#52e9e6"
    for index, label in enumerate(("Mixer", "Channel", "Input", "FX", "Sends", "Meters")):
        x = index * 87
        key((x, 0, x + 85, 29), label, "#173839" if not index else "#2d2e2f",
            accent if not index else "#d5d6d6", 14)

    names = ("Vocal", "BGM", "Keys", "Bass", "Drum", "Pad", "Chat", "Verb", "Delay", "Stream", "Mon", "Main")
    colors = ("#21b5dd", "#ffb24d", "#34d2a7", "#b188f3", "#ef7d7b", "#93a7f7")
    gains = (-10, -28, -15, -12, -22, -17, -32, -20, -26, -5, -8, -3)
    for index, name in enumerate(names):
        x = index * 43
        left, right = x + 2, x + 41
        color = colors[index % len(colors)]
        draw.rectangle((x + 1, 31, x + 42, 457), fill="#173839" if not index else "#232424")
        key((left, 34, right, 53), f"In {index + 1}", "#323435", accent)
        key((left, 56, x + 20, 70), "Ø")
        key((x + 23, 56, right, 70), "↔")
        for top, caption, slots in ((73, "FX", 7), (170, "Sends", 4)):
            key((left, top, x + 29, top + 15), caption, size=9 if cover and caption == "Sends" else 11)
            key((x + 31, top, right, top + 15), "+")
            for slot in range(slots):
                y = top + 17 + slot * 11
                draw.rectangle((left, y, right, y + 9), fill="#323435")
                if slot < 1 + index % 3:
                    labels = ("EQ", "Comp", "Gate") if slots == 7 else ("Main", "Mon", "FX")
                    text(x + 22, y + 5, labels[slot], 8, accent if slots == 7 else "#d5d6d6")

        draw.rectangle((left, 235, right, 255), fill=color)
        text(x + 22, 245, name, 11, "#101010", True)
        key((left, 258, right, 276), "Solo", "#e1ca46" if index == 6 else "#3c3d3e",
            "#231f11" if index == 6 else "#d5d6d6")
        key((left, 279, right, 296), f"{gains[index]:.1f}", "#323435")
        draw.rectangle((left, 299, right, 410), fill="#202121")
        draw.rectangle((x + 18, 305, x + 22, 405), fill="#101111")
        draw.rectangle((x + 32, 305, x + 38, 405), fill="#101111")
        meter_height = 30 + (index * 13) % 62
        draw.rectangle((x + 33, 405 - meter_height, x + 34, 405), fill="#95e753")
        draw.rectangle((x + 36, 411 - meter_height, x + 37, 405), fill="#95e753")
        for tick in range(9):
            y = 309 + tick * 11
            draw.line((x + 12, y, x + 15, y), fill="#828686")
        thumb = 325 + round(-gains[index] * 1.8)
        for offset, shade in enumerate(("#d3d7d7", "#949b9d", "#656a6d", "#d5d9d9", "#5c6265", "#aaaeb0")):
            y = thumb + offset * 2
            draw.rectangle((x + 12, y, x + 28, y + 1), fill=shade)
        key((left, 414, x + 20, 430), "REC", size=8)
        key((x + 23, 414, right, 430), "—")
        key((left, 433, right, 450), "Mute")
        text(x + 22, 458, f"{index + 1:02}", 8, "#aaadad")

    draw.rectangle((521, 0, 639, 463), fill="#2d2e2f")
    text(580, 18, "AIRCORE", 23 if cover else 28, bold=True)
    text(580, 41, "48.0 kHz · 128f", 12, "#aaadad")
    text(580, 56, "7.0 ms", 11, "#aaadad")
    for index, label in enumerate(("Set", "List", "+", "Play", "Save", "Open")):
        x, y = 527 + index % 2 * 54, 67 + index // 2 * 21
        key((x, y, x + 50, y + 17), label)
    key((527, 205, 633, 225), "Solo")
    text(554, 244, "Out", 12, "#aaadad", True)
    key((527, 254, 633, 276), "Main", "#173839", accent)
    key((527, 280, 577, 300), "Stream")
    key((582, 280, 633, 300), "Mon")
    return image


def render_cover(mixer):
    cover = Image.new("RGB", (1200, 900), "#171a1b")
    draw = ImageDraw.Draw(cover)
    fonts = Path("C:/Windows/Fonts")
    title = ImageFont.truetype(str(fonts / "arialbi.ttf"), 72)
    caption = ImageFont.truetype(str(fonts / "arial.ttf"), 20)
    draw.text((76, 77), "AIRCORE", font=title, fill="#f1f2f2", anchor="lm")
    draw.text((1124, 85), "Audcore mixer skin", font=caption, fill="#52e9e6", anchor="rm")
    draw.rounded_rectangle((73, 137, 1126, 882), radius=15, fill="#080808", outline="#555858", width=2)
    surface = mixer.crop((0, 0, 640, 464)).resize((1010, 732), Image.Resampling.LANCZOS)
    cover.paste(surface, (95, 143))
    return cover


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cover", action="store_true", help="render the standalone AIRCORE cover")
    args = parser.parse_args()
    mixer = render(cover=args.cover)
    target = Path(__file__).with_name("web")
    if args.cover:
        render_cover(mixer).save(target / "xair-cover.png", optimize=True)
    else:
        mixer.resize((160, 120), Image.Resampling.LANCZOS).save(target / "xair-preview.png", optimize=True)
