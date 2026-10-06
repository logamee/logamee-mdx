import {
  DOCX_ALLOWED_IMAGE_MIME_TYPES,
  DOCX_PREVIEW_LIMITS,
  type DocxImageResource,
} from './docxResources';
import { DocxSanitizationError } from './docxSanitizerErrors';

const REGISTERED_PLACEHOLDER_PATTERN = /^https:\/\/[0-9a-f]{32}\.invalid\/image\/[1-9][0-9]*$/;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ALLOWED_IMAGE_MIME_SET: ReadonlySet<string> = new Set(DOCX_ALLOWED_IMAGE_MIME_TYPES);

function expectedBase64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

// 规范 Base64：长度与字节数一致且填充位数与模 3 余数匹配。
function hasCanonicalBase64Length(resource: DocxImageResource): boolean {
  const encoded = resource.bytesBase64;
  if (encoded.length !== expectedBase64Length(resource.byteLength)) return false;
  if (!CANONICAL_BASE64_PATTERN.test(encoded)) return false;
  if (resource.byteLength % 3 === 0) return !encoded.endsWith('=');
  if (resource.byteLength % 3 === 1) return encoded.endsWith('==');
  return encoded.endsWith('=') && !encoded.endsWith('==');
}

// 形状校验：占位符格式、无重复、MIME 白名单与字节量界。
function imageShapeInvalid(image: DocxImageResource, registered: ReadonlyMap<string, DocxImageResource>): boolean {
  return image === null || typeof image !== 'object'
    || !REGISTERED_PLACEHOLDER_PATTERN.test(image.placeholder)
    || registered.has(image.placeholder)
    || !ALLOWED_IMAGE_MIME_SET.has(image.mimeType)
    || !Number.isSafeInteger(image.byteLength)
    || image.byteLength <= 0
    || image.byteLength > DOCX_PREVIEW_LIMITS.maxImageBytes;
}

// 尺寸校验：宽高正整数、像素总量受上限约束且与 pixelCount 一致。
function imageDimensionsInvalid(image: DocxImageResource): boolean {
  return !Number.isSafeInteger(image.width)
    || !Number.isSafeInteger(image.height)
    || image.width <= 0
    || image.height <= 0
    || image.width > Math.floor(DOCX_PREVIEW_LIMITS.maxImagePixels / image.height)
    || image.pixelCount !== image.width * image.height;
}

// 登记图片资源：逐项形状/尺寸/编码校验并聚合总量上限。
export function getRegisteredImages(
  images: readonly DocxImageResource[],
): ReadonlyMap<string, DocxImageResource> {
  if (!Array.isArray(images) || images.length > DOCX_PREVIEW_LIMITS.maxImages) {
    throw new DocxSanitizationError();
  }

  const registered = new Map<string, DocxImageResource>();
  let totalBytes = 0;
  let totalPixels = 0;

  for (const image of images) {
    if (imageShapeInvalid(image, registered)
      || imageDimensionsInvalid(image)
      || !hasCanonicalBase64Length(image)) {
      throw new DocxSanitizationError();
    }
    totalBytes += image.byteLength;
    totalPixels += image.pixelCount;
    if (totalBytes > DOCX_PREVIEW_LIMITS.maxTotalImageBytes
      || totalPixels > DOCX_PREVIEW_LIMITS.maxTotalImagePixels) {
      throw new DocxSanitizationError();
    }
    registered.set(image.placeholder, image);
  }

  return registered;
}
