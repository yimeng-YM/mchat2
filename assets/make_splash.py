"""Generate splash.png: cream bg + rounded real app icon + MChat2 title.
Reproduces the original splash.svg layout, swapping the old hand-drawn
logo for the real icon-only.png."""
from PIL import Image, ImageDraw, ImageFont

W = H = 2732
BG = (246, 245, 241)          # #f6f5f1
TITLE_FILL = (38, 48, 43)     # #26302b

ICON_X, ICON_Y, ICON_S, ICON_R = 1088, 1050, 556, 168
CX = 1366                     # horizontal center (text-anchor=middle)

canvas = Image.new("RGB", (W, H), BG)

# --- rounded real icon card ---
icon = Image.open("assets/icon-only.png").convert("RGB").resize((ICON_S, ICON_S), Image.LANCZOS)
mask = Image.new("L", (ICON_S, ICON_S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, ICON_S - 1, ICON_S - 1], radius=ICON_R, fill=255)
canvas.paste(icon, (ICON_X, ICON_Y), mask)

draw = ImageDraw.Draw(canvas)

# --- title "MChat2" (baseline y=1740, size 104, semibold) ---
title_font = ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", 104, index=0)
draw.text((CX, 1740), "MChat2", font=title_font, fill=TITLE_FILL, anchor="ms")

canvas.save("assets/splash.png")
print("wrote assets/splash.png", canvas.size)
