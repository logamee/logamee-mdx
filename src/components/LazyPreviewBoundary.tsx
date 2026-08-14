import {
  Component,
  Suspense,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { emitAppFeedbackError } from '../lib/appFeedback';
import type { EffectiveLocale } from '../lib/locale';

interface LazyPreviewBoundaryProps {
  children: ReactNode;
  loadingLabel: string;
  locale: EffectiveLocale;
}

function PreviewLoadingStatus({ label }: { label: string }) {
  return (
    <output className="lazy-preview-loading" aria-busy="true">
      {label}
    </output>
  );
}

interface LazyPreviewErrorBoundaryState {
  failed: boolean;
}

class LazyPreviewErrorBoundary extends Component<
  LazyPreviewBoundaryProps,
  LazyPreviewErrorBoundaryState
> {
  state: LazyPreviewErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazyPreviewErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _errorInfo: ErrorInfo) {
    emitAppFeedbackError(error);
  }

  render() {
    if (this.state.failed) {
      return <div className="lazy-preview-loading is-failed" aria-hidden="true" />;
    }

    return (
      <Suspense fallback={<PreviewLoadingStatus label={this.props.loadingLabel} />}>
        {this.props.children}
      </Suspense>
    );
  }
}

export function LazyPreviewBoundary(props: LazyPreviewBoundaryProps) {
  return <LazyPreviewErrorBoundary {...props} />;
}
