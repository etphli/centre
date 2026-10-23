import { Component, type ReactNode } from 'react';
import { friendlyError } from './ui';

export class PageBoundary extends Component<{ children: ReactNode; prepare: () => Promise<void> }, { failed: boolean; busy: boolean; error: string | null }> {
  state: { failed: boolean; busy: boolean; error: string | null } = { failed: false, busy: false, error: null };
  static getDerivedStateFromError() { return { failed: true }; }
  async reload() {
    this.setState({ busy: true, error: null });
    try { await this.props.prepare(); location.reload(); }
    catch (error) { this.setState({ busy: false, error: friendlyError(error) }); }
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="notice" role="alert"><h2>This page could not open</h2><p>Reconnect to the internet, then reload Centre. Your saved work stays on this device. You can also try another study page.</p><button className="button" disabled={this.state.busy} onClick={() => void this.reload()}>{this.state.busy ? 'Preparing to reload…' : 'Reload Centre'}</button>{this.state.error ? <p className="error">{this.state.error}</p> : null}</section>;
  }
}
