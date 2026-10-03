# TIFF fixtures

Synthetic, tiny, and **not produced by `utif2`** — that last part is the whole point.

`tiff.test.ts` used to build its fixtures by encoding with `utif2` and then decoding with
`utif2`. Those tests passed while a production run failed to read 45 of one patient's 45
TIFFs, because a round trip only proves the library agrees with itself. These files are
written by libtiff instead, in the compressions the real corpus actually arrives in:

| file                          | compression (t259)  | photometric (t262) | bits (t258) | of the measured 45 |
| ----------------------------- | ------------------- | ------------------ | ----------- | ------------------ |
| `ccitt-g4-bilevel.tif`        | 4, CCITT Group 4    | 0, WhiteIsZero     | 1           | 34                 |
| `ccitt-g4-bilevel-2page.tif`  | 4, CCITT Group 4    | 0, WhiteIsZero     | 1           | (multi-page faxes) |
| `lzw-rgb.tif`                 | 5, LZW              | 2, RGB             | 8, 8, 8     | 11                 |

Group 4 is what a fax machine emits, which is how most clinical TIFF reaches us. Those two
compressions account for all 45 documents measured on patient
`45c07b01-2752-4535-bbe0-7fd642a12b62`; no tiled, old-style-JPEG or JPEG-in-TIFF file
appeared in that sample.

Each page is 64×32: white, a full-width black bar across rows 8–15, and a 16px black square
at rows 20–27. The test asserts where the ink landed, not merely that a PNG came back — an
all-white page is exactly what a decoder that mishandles a compression tends to return.

## Regenerating

Requires ImageMagick and libtiff (`brew install imagemagick libtiff`). **Do not regenerate
these with `utif2`**; `tiff.test.ts` asserts the tag profile above specifically to catch that.

```sh
BILEVEL=(-monochrome -depth 1 -type bilevel -define quantum:polarity=min-is-white)

magick -size 64x32 xc:white -fill black -draw "rectangle 0,8 63,15" \
  -draw "rectangle 48,20 63,27" "${BILEVEL[@]}" -compress Group4 ccitt-g4-bilevel.tif

magick -size 64x32 xc:white -fill black -draw "rectangle 0,0 63,7"   "${BILEVEL[@]}" -compress Group4 p1.tif
magick -size 64x32 xc:white -fill black -draw "rectangle 0,24 63,31" "${BILEVEL[@]}" -compress Group4 p2.tif
tiffcp -c g4 p1.tif p2.tif ccitt-g4-bilevel-2page.tif && rm p1.tif p2.tif

magick -size 64x32 xc:white -fill black -draw "rectangle 0,8 63,15" \
  -draw "rectangle 48,20 63,27" -depth 8 -type TrueColor -compress LZW lzw-rgb.tif
```

Verify with `tiffinfo <file>`.

No real patient document belongs in this directory.
