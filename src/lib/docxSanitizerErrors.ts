// DOCX 预览净化失败错误：净化器与图片登记共用，保持对外错误身份稳定。
export class DocxSanitizationError extends Error {
  constructor(message = 'The DOCX did not contain a usable preview.') {
    super(message);
    this.name = 'DocxSanitizationError';
  }
}
