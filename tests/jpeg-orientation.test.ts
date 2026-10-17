import { describe, expect, it } from "vitest";
import { jpegOrientation, orientationTransform } from "@/lib/jpeg-orientation";

// 組一個最小的 JPEG：SOI + APP1(Exif, IFD0 只有 Orientation 一筆) + SOS。
function jpegWithOrientation(value: number, endian: "II" | "MM"): Buffer {
  const le = endian === "II";
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write(endian, 0, "latin1");
  const w16 = (v: number, o: number) => (le ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
  const w32 = (v: number, o: number) => (le ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
  w16(42, 2);
  w32(8, 4); // IFD0 緊接在 header 後
  w16(1, 8); // 一筆
  w16(0x0112, 10); // Orientation
  w16(3, 12); // SHORT
  w32(1, 14);
  w16(value, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, payload, Buffer.from([0xff, 0xda, 0, 2])]);
}

describe("jpegOrientation", () => {
  it("讀得出大端與小端的 Orientation", () => {
    expect(jpegOrientation(jpegWithOrientation(6, "MM"))).toBe(6);
    expect(jpegOrientation(jpegWithOrientation(8, "II"))).toBe(8);
    expect(jpegOrientation(jpegWithOrientation(3, "II"))).toBe(3);
  });

  it("沒有 EXIF、不是 JPEG、截斷、值超出範圍都當成 1", () => {
    expect(jpegOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
    expect(jpegOrientation(Buffer.from("\x89PNG\r\n", "latin1"))).toBe(1);
    expect(jpegOrientation(jpegWithOrientation(6, "MM").subarray(0, 20))).toBe(1);
    expect(jpegOrientation(jpegWithOrientation(9, "MM"))).toBe(1);
    expect(jpegOrientation(Buffer.alloc(0))).toBe(1);
  });
});

describe("orientationTransform", () => {
  it("直拍（6）轉 90 度、倒拍（3）轉 180 度、正常的不轉", () => {
    expect(orientationTransform(6)).toBe("rotate(90deg)");
    expect(orientationTransform(3)).toBe("rotate(180deg)");
    expect(orientationTransform(1)).toBeUndefined();
  });
});
