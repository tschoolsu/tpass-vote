# 從 Noto Sans CJK 集合檔抽出 TC 的指定字重，子集到 CJK 基本區＋Big5（cp950）＋ASCII＋常用符號，轉成 TrueType。
# 只切 Big5 不夠：喆、堃這類人名常見字不在 Big5 裡，缺字時 next/og 會去 Google Fonts 抓別的字重補，
# 粗細對不上，而且離線就變方塊。
#
# 用法（字型來源是 Noto Sans CJK 的 .ttc；index 23＝TC Black、38＝TC Bold）：
#   uv run --no-project --with fonttools python -I build-subset.py NotoSansCJK.ttc NotoSansTC-Black.ttf 23
import sys
from fontTools.ttLib import TTCollection, newTable
from fontTools import subset
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

src, out = sys.argv[1], sys.argv[2]
index = int(sys.argv[3])

chars = set(range(0x20, 0x7F))
chars |= set(range(0x3000, 0x3040))  # CJK 標點
chars |= set(range(0xFF00, 0xFFF0))  # 全形
chars |= set(range(0x2010, 0x2070))  # 一般標點（— … ‧ 等）
chars |= set(range(0x3100, 0x3130))  # 注音
chars |= {0x00B7, 0x00D7}
chars |= set(range(0x4E00, 0xA000))  # CJK 基本區
for hi in range(0x81, 0xFF):
    for lo in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
        try:
            chars |= {ord(c) for c in bytes([hi, lo]).decode("cp950")}
        except UnicodeDecodeError:
            pass

font = TTCollection(src).fonts[index]
opts = subset.Options()
opts.layout_features = ["kern", "palt"]
opts.hinting = False
opts.desubroutinize = True
opts.name_IDs = ["*"]
opts.notdef_outline = True
s = subset.Subsetter(opts)
s.populate(unicodes=chars)
s.subset(font)

# CFF(CID) → glyf：satori 底層的 opentype.js 對 CID-keyed CFF 支援不穩，轉成 TrueType 最保險。
order = font.getGlyphOrder()
gs = font.getGlyphSet()
glyf = newTable("glyf"); glyf.glyphOrder = order; glyf.glyphs = {}
for name in order:
    pen = TTGlyphPen(gs)
    gs[name].draw(Cu2QuPen(pen, max_err=1.0, reverse_direction=True))
    glyf.glyphs[name] = pen.glyph()
font["glyf"] = glyf
font["loca"] = newTable("loca")
maxp = font["maxp"]; maxp.tableVersion = 0x00010000
for a in ("maxZones","maxTwilightPoints","maxStorage","maxFunctionDefs","maxInstructionDefs","maxStackElements","maxSizeOfInstructions","maxComponentElements"):
    setattr(maxp, a, 0)
maxp.maxZones = 1
del font["CFF "]
if "VORG" in font: del font["VORG"]
font["head"].glyphDataFormat = 0
font["post"].formatType = 3.0
font.sfntVersion = "\x00\x01\x00\x00"
font.save(out)
print(out, len(chars), "chars", len(order), "glyphs")
