import { Component, type ErrorInfo, type ReactNode } from 'react';

type ErrorBoundaryProps = { children: ReactNode };
type ErrorBoundaryState = { error: Error | null };

/**
 * 兜底渲染层：任一页面组件抛错时，React 默认会把整棵树卸载成白屏。
 * 这里保留一个可读的失败页并给出刷新入口，至少让用户知道「数据没丢、可以重试」。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('页面渲染失败：', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <div className="app-crash" role="alert">
      <h1>页面遇到问题</h1>
      <p>某个界面组件渲染失败，服务端数据没有丢失，刷新后通常可以恢复。</p>
      <pre>{this.state.error.message}</pre>
      <button type="button" className="primary" onClick={() => window.location.reload()}>刷新页面</button>
    </div>;
  }
}
