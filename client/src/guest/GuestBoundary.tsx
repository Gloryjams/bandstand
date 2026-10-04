import { Component, type ReactNode } from "react";

/**
 * Last line of defence for the guest page. The DTO is normalized on arrival, but a
 * payload shaped in some way the renderer still cannot draw must not leave a stranger
 * staring at a blank screen: anything thrown below here shows the same dead-link state
 * every other failure uses. Nothing is logged, and the guest is told nothing about why
 * (the server's whole token gate is built on one indistinguishable failure).
 */
export class GuestBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
