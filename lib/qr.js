// QR code endpoint for the performer page URL.
//
// Reusable PNDS core: exposes GET /qr on a given Express app, rendering a
// PNG that performers scan to reach the performer page. The monitor page
// loads it via a plain <img> tag.

const QRCode = require("qrcode");

const DEFAULT_WIDTH = 480;
const DEFAULT_MARGIN = 1;

function qrHandler(url, { width = DEFAULT_WIDTH, margin = DEFAULT_MARGIN } = {}) {
  return (request, response) => {
    QRCode.toBuffer(url, {
      type: "png",
      width,
      margin,
      errorCorrectionLevel: "M",
    })
      .then((buffer) => {
        response.type("image/png").send(buffer);
      })
      .catch((error) => {
        console.error("[qr] generation failed:", error);
        response.status(500).send("QR generation failed.");
      });
  };
}

module.exports = {
  qrHandler,
};
