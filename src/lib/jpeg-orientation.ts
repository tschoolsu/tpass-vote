// 讀 JPEG 的 EXIF Orientation（1–8）。瀏覽器顯示 <img> 時會自動照它轉正，satori（分享圖）
// 不會，手機直拍的照片就會躺著。上傳時瀏覽器端壓縮過的照片已經被 canvas 轉正、EXIF 也沒了，
// 會出事的是小到沒觸發壓縮、原檔直接上傳的那些。
//
// 只解析到找出 Orientation 為止；任何格式不對或越界都當作 1（不轉），寧可躺著也不要炸掉整張圖。

const ORIENTATION_TAG = 0x0112;

/** 回傳 TIFF header 的位移（APP1 "Exif\0\0" 之後），找不到回 -1。 */
function findExifTiff(buf: Buffer): number {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return -1;
  let off = 2;
  while (off + 4 <= buf.length && buf[off] === 0xff) {
    const marker = buf[off + 1];
    // SOS 之後是影像資料，EXIF 不會在那後面。
    if (marker === 0xda) return -1;
    if (marker === 0xe1 && buf.toString("latin1", off + 4, off + 10) === "Exif\0\0") return off + 10;
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return -1;
}

function readOrientation(buf: Buffer, tiff: number): number {
  const le = buf.toString("latin1", tiff, tiff + 2) === "II";
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = tiff + u32(tiff + 4);
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) === ORIENTATION_TAG) return u16(entry + 8);
  }
  return 1;
}

export function jpegOrientation(buf: Buffer): number {
  try {
    const tiff = findExifTiff(buf);
    if (tiff < 0) return 1;
    const v = readOrientation(buf, tiff);
    return v >= 1 && v <= 8 ? v : 1;
  } catch {
    // readUInt* 越界會丟 RangeError：截斷或亂寫的 EXIF。
    return 1;
  }
}

/** 把 Orientation 換成 CSS transform，讓圖在正方形框裡轉正。1 回 undefined（不用轉）。 */
export function orientationTransform(orientation: number): string | undefined {
  switch (orientation) {
    case 2:
      return "scaleX(-1)";
    case 3:
      return "rotate(180deg)";
    case 4:
      return "scaleY(-1)";
    case 5:
      return "rotate(90deg) scaleY(-1)";
    case 6:
      return "rotate(90deg)";
    case 7:
      return "rotate(270deg) scaleY(-1)";
    case 8:
      return "rotate(270deg)";
    default:
      return undefined;
  }
}
