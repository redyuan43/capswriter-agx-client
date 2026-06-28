import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { Toaster } from './components/ui/sonner'

const isElectron = () => {
  return typeof window !== 'undefined' && window.electronAPI
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(_error) {
    return { hasError: true }
  }

  componentDidCatch(error, errorInfo) {
    this.setState({
      error: error,
      errorInfo: errorInfo
    })
    
    if (isElectron()) {
      window.electronAPI.log('error', `React Error: ${error.message}`)
    } else {
      console.error('React Error:', error, errorInfo)
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-red-50 to-red-100 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-lg p-6 max-w-md w-full">
            <div className="flex items-center mb-4">
              <div className="w-8 h-8 bg-red-500 rounded-full flex items-center justify-center mr-3">
                <span className="text-white text-sm">!</span>
              </div>
              <h2 className="text-lg font-semibold text-gray-900">应用出现错误</h2>
            </div>
            
            <p className="text-gray-600 mb-4">
              语音转写遇到了一个意外错误。请尝试重启应用。
            </p>
            
            {process.env.NODE_ENV === 'development' && (
              <details className="mb-4">
                <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700">
                  查看错误详情
                </summary>
                <div className="mt-2 p-3 bg-gray-100 rounded text-xs font-mono text-gray-700 overflow-auto max-h-32">
                  <div className="mb-2">
                    <strong>错误:</strong> {this.state.error && this.state.error.toString()}
                  </div>
                  <div>
                    <strong>堆栈:</strong>
                    <pre className="whitespace-pre-wrap">
                      {this.state.errorInfo?.componentStack || this.state.error?.stack || '暂无堆栈信息'}
                    </pre>
                  </div>
                </div>
              </details>
            )}
            
            <div className="flex space-x-3">
              <button
                onClick={() => window.location.reload()}
                className="flex-1 bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
              >
                重新加载
              </button>
              
              {isElectron() && (
                <button
                  onClick={() => window.electronAPI.closeWindow()}
                  className="flex-1 bg-gray-500 hover:bg-gray-600 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors"
                >
                  关闭应用
                </button>
              )}
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

function initializeApp() {
  if (!isElectron()) {
    // Electron API not available
  }

  window.addEventListener('error', (event) => {
    if (isElectron()) {
      window.electronAPI.log('error', `Global Error: ${event.error?.message || event.message}`)
    }
  })

  window.addEventListener('unhandledrejection', (event) => {
    if (isElectron()) {
      window.electronAPI.log('error', `Unhandled Promise Rejection: ${event.reason}`)
    }
  })

  document.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })

  document.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })

  if (process.env.NODE_ENV === 'production') {
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault()
    })
  }

  document.documentElement.lang = 'zh-CN'
  
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.classList.add('dark')
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (e.matches) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  })
}

initializeApp()

const root = ReactDOM.createRoot(document.getElementById('root'))

root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
      <Toaster />
    </ErrorBoundary>
  </React.StrictMode>
)

if (process.env.NODE_ENV === 'development') {
  if (import.meta.hot) {
    import.meta.hot.accept('./App.jsx', (newModule) => {
      if (newModule) {
        const NextApp = newModule.default
        root.render(
          <React.StrictMode>
            <ErrorBoundary>
              <NextApp />
            </ErrorBoundary>
          </React.StrictMode>
        )
      }
    })
  }
}
