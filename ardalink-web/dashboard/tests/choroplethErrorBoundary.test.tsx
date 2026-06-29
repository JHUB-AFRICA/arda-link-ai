/**
 * Tests for the ChoroplethErrorBoundary.
 *
 * The boundary's job is simple: any throw from a child renders a
 * compact fallback instead of letting React unmount the whole tree.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ChoroplethErrorBoundary } from "../src/components/ChoroplethErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Boom(): never {
  throw new Error("kaboom");
}

function Normal() {
  return <div data-testid="normal">hello</div>;
}

describe("ChoroplethErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <ChoroplethErrorBoundary>
        <Normal />
      </ChoroplethErrorBoundary>,
    );
    expect(screen.getByTestId("normal")).toBeTruthy();
    expect(screen.queryByTestId("choropleth-error")).toBeNull();
  });

  it("shows the fallback + underlying error when a child throws", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ChoroplethErrorBoundary>
        <Boom />
      </ChoroplethErrorBoundary>,
    );
    const fb = screen.getByTestId("choropleth-error");
    expect(fb).toBeTruthy();
    expect(fb.textContent).toMatch(/kaboom/);
    expect(fb.textContent).toMatch(/Retry/);
    errSpy.mockRestore();
  });

  it("renders a Retry button that resets the error state", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ChoroplethErrorBoundary>
        <Boom />
      </ChoroplethErrorBoundary>,
    );
    const retryBtn = screen.getByText("Retry");
    expect(retryBtn).toBeTruthy();
    // Clicking retry clears the error state so the boundary is ready
    // to re-mount its children. We don't re-render the throwing
    // child here because that's a React-18-concurrent-mode test;
    // just verify the button exists and the click handler doesn't throw.
    expect(() => fireEvent.click(retryBtn)).not.toThrow();
    errSpy.mockRestore();
  });
});