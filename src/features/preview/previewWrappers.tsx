import { lazy } from 'react';
import type { ComponentProps } from 'react';

import type { EffectiveLocale } from '../../lib/locale';
import { LazyPreviewBoundary } from './LazyPreviewBoundary';

const LazyDocxPreview = lazy(() => import('./DocxPreview').then((module) => ({
  default: module.DocxPreview,
})));
const LazyExcalidrawPane = lazy(async () => {
  const module = await import('./ExcalidrawPane');
  return { default: module.ExcalidrawPane };
});
const LazyPdfPreview = lazy(() => import('./PdfPreview').then((module) => ({
  default: module.PdfPreview,
})));

interface LazyPreviewWrapperProps {
  loadingLabel: string;
  locale: EffectiveLocale;
}

export function DocxPreview({ loadingLabel, locale, ...props }:
ComponentProps<typeof LazyDocxPreview> & LazyPreviewWrapperProps) {
  return (
    <LazyPreviewBoundary loadingLabel={loadingLabel} locale={locale}>
      <LazyDocxPreview {...props} />
    </LazyPreviewBoundary>
  );
}

export function ExcalidrawPane({ loadingLabel, locale, ...props }:
ComponentProps<typeof LazyExcalidrawPane> & LazyPreviewWrapperProps) {
  return (
    <LazyPreviewBoundary loadingLabel={loadingLabel} locale={locale}>
      <LazyExcalidrawPane {...props} />
    </LazyPreviewBoundary>
  );
}

export function PdfPreview({ loadingLabel, locale, ...props }:
ComponentProps<typeof LazyPdfPreview> & LazyPreviewWrapperProps) {
  return (
    <LazyPreviewBoundary loadingLabel={loadingLabel} locale={locale}>
      <LazyPdfPreview {...props} />
    </LazyPreviewBoundary>
  );
}


interface LazyPreviewWrapperProps {
  loadingLabel: string;
  locale: EffectiveLocale;
}
