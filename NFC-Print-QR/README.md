# NFC / QR Print Assets

This directory contains six offline-generated QR Code Model 2 SVG files for the fixed
Netlify visitor claim URLs. Open `QR-Print-Sheet.html` in a browser to print all six
labels on A4 paper.

Files:

- `M-01-museum-mark.svg`
- `A-01-bone-awl.svg`
- `A-02-stone-axe.svg`
- `A-03-bone-flute.svg`
- `A-04-tortoise-shell.svg`
- `A-05-bone-knife.svg`
- `claim-urls.txt` contains the exact NFC/QR payloads.

Encoding: QR Code Model 2, Version 8, byte mode, error-correction level Q, four-module
quiet zone. The generator is fully local and does not use a CDN, network request, or
external package. Re-run `node generate-qr.js` to regenerate the same six assets.

Before locking each NFC tag, test that both its NFC payload and the matching QR image open
the exact claim URL shown in `claim-urls.txt` on a phone.
