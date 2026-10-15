/* global document, Image */
// 流程图共用的画布工具：读截图、打码、缩小。在浏览器里运行，由 phone.html 和 zotero.html 引用。
//
// 打码分三种：erase 用底色抹掉；redact 先用底色抹掉原文、再画一段模糊的占位字，
// 最终图片里不含任何原始像素，没法从模糊结果里还原；blur 直接原位模糊，只用于非文字内容。

export function loadImage(src) {
  const image = new Image();
  image.src = src;
  return image.decode().then(() => image);
}

export function roundedRect(context, { x, y, w, h }, radius) {
  context.beginPath();
  context.roundRect(x, y, w, h, radius);
}

export function sampleColor(source, { x, y }) {
  const [red, green, blue] = source.getImageData(x, y, 1, 1).data;
  return `rgb(${red}, ${green}, ${blue})`;
}

// 抹掉原文后画模糊的占位字：结果看着像打了毛玻璃的文字，但和原文没有关系。
export function redact(context, source, mask) {
  const { rect } = mask;
  const background = mask.background ?? sampleColor(source, mask.sampleAt);
  context.save();
  roundedRect(context, rect, mask.radius ?? 8);
  context.clip();
  context.fillStyle = background;
  context.fillRect(rect.x, rect.y, rect.w, rect.h);

  // 占位字先画在留了边的离屏画布上，再整体模糊贴回，免得模糊把边缘吃成透明。
  const padding = mask.blur * 3;
  const scratch = document.createElement("canvas");
  scratch.width = rect.w + padding * 2;
  scratch.height = rect.h + padding * 2;
  const scratchContext = scratch.getContext("2d");
  scratchContext.fillStyle = background;
  scratchContext.fillRect(0, 0, scratch.width, scratch.height);
  scratchContext.font = mask.font;
  scratchContext.fillStyle = mask.color;
  scratchContext.textAlign = "center";
  scratchContext.textBaseline = "middle";
  const lineHeight = mask.lineHeight ?? 0;
  mask.lines.forEach((line, index) => {
    const offset = (index - (mask.lines.length - 1) / 2) * lineHeight;
    scratchContext.fillText(line, scratch.width / 2, scratch.height / 2 + offset, rect.w);
  });
  context.filter = `blur(${mask.blur}px)`;
  context.drawImage(scratch, rect.x - padding, rect.y - padding);
  context.restore();
}

export function blurInPlace(context, original, mask) {
  const { rect, amount } = mask;
  const padding = amount * 3;
  context.save();
  roundedRect(context, rect, 16);
  context.clip();
  context.filter = `blur(${amount}px)`;
  context.drawImage(original, rect.x - padding, rect.y - padding, rect.w + padding * 2, rect.h + padding * 2,
    rect.x - padding, rect.y - padding, rect.w + padding * 2, rect.h + padding * 2);
  context.restore();
}

// 换成灰色默认头像：圆角方框里一个人像剪影。
export function drawDefaultAvatar(context, { x, y, w, h }) {
  context.save();
  context.fillStyle = "#fff";
  context.fillRect(x, y, w, h);
  roundedRect(context, { x: x + 4, y: y + 4, w: w - 8, h: h - 8 }, 26);
  context.fillStyle = "#eef0f3";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#e1e4e8";
  context.stroke();
  roundedRect(context, { x: x + 4, y: y + 4, w: w - 8, h: h - 8 }, 26);
  context.clip();
  context.fillStyle = "#c6cbd2";
  const centerX = x + w / 2;
  context.beginPath();
  context.arc(centerX, y + h * 0.40, w * 0.18, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.ellipse(centerX, y + h * 0.98, w * 0.36, h * 0.32, 0, Math.PI, 0);
  context.fill();
  context.restore();
}

export function processShot(image, masks) {
  const original = document.createElement("canvas");
  original.width = image.naturalWidth;
  original.height = image.naturalHeight;
  const originalContext = original.getContext("2d", { willReadFrequently: true });
  originalContext.drawImage(image, 0, 0);

  const canvas = document.createElement("canvas");
  canvas.width = original.width;
  canvas.height = original.height;
  const context = canvas.getContext("2d");
  context.drawImage(original, 0, 0);
  for (const mask of masks) {
    if (mask.type === "erase") {
      context.fillStyle = sampleColor(originalContext, mask.sampleAt);
      context.fillRect(mask.rect.x, mask.rect.y, mask.rect.w, mask.rect.h);
    } else if (mask.type === "redact") {
      redact(context, originalContext, mask);
    } else if (mask.type === "blur") {
      blurInPlace(context, original, mask);
    } else if (mask.type === "avatar") {
      drawDefaultAvatar(context, mask.rect);
    }
  }
  return canvas;
}

// 逐级减半再缩到目标宽度，比一步缩到三分之一清楚。
export function downscale(source, width) {
  let current = source;
  while (current.width / 2 > width) {
    const half = document.createElement("canvas");
    half.width = Math.round(current.width / 2);
    half.height = Math.round(current.height / 2);
    const context = half.getContext("2d");
    context.imageSmoothingQuality = "high";
    context.drawImage(current, 0, 0, half.width, half.height);
    current = half;
  }
  const result = document.createElement("canvas");
  result.width = width;
  result.height = Math.round(source.height * width / source.width);
  const context = result.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(current, 0, 0, result.width, result.height);
  return result;
}
