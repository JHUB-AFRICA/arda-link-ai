import { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface ChoroplethErrorBoundaryProps {
  children: ReactNode;
}

interface ChoroplethErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary for the Choropleth component.
 *
 * Wraps the Leaflet map + data panels so a runtime exception
 * (e.g. an event handler throwing, or a tile provider returning
 * a malformed response) can't blank the whole dashboard. The
 * boundary shows a compact fallback with the underlying error and
 * a retry button that remounts the subtree.
 */
export class ChoroplethErrorBoundary extends Component<
  ChoroplethErrorBoundaryProps,
  ChoroplethErrorBoundaryState
> {
  state: ChoroplethErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ChoroplethErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log so we can see it in dev / Sentry. Keeps the dashboard alive
    // even if a third-party library throws inside the tree.
    // eslint-disable-next-line no-console
    console.error("[Choropleth] runtime error:", error, info.componentStack);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    const err = this.state.error;
    return (
      <div
        data-testid="choropleth-error"
        className="bg-gray-900 border border-red-800/60 rounded-2xl p-6 space-y-3"
        role="alert"
      >
        <div className="flex items-center gap-2 text-red-300">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <h2 className="text-sm font-semibold">Choropleth failed to render</h2>
        </div>
        <p className="text-xs text-gray-400 leading-relaxed">
          The interactive map crashed and was taken offline so the rest of
          the dashboard stays usable. The underlying error has been logged
          to the browser console.
        </p>
        {err && (
          <pre className="text-[10px] text-red-200/80 bg-gray-950 border border-gray-800 rounded p-2 overflow-x-auto max-h-32">
            {err.message}
          </pre>
        )}
        <button
          type="button"
          onClick={this.handleRetry}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </button>
      </div>
    );
  }
}

export default ChoroplethErrorBoundary;
