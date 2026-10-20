import React, { useState } from 'react'
import './App.css'

interface PubMedArticle {
  pmid: string
  title: string
  authors: string
  journal: string
  publishedDate: string
  url: string
}

interface ResearchResponse {
  success: boolean
  question: string
  count: number
  answer?: string
  articles: PubMedArticle[]
  message?: string
}

export interface ChatSession {
  id: string
  question: string
  createdAt: string
  result: ResearchResponse
}

const STORAGE_KEY = 'medical_research_ai_chat_history'

function loadHistoryFromStorage(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed.filter((item): item is ChatSession => {
      return (
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.question === 'string' &&
        typeof item.createdAt === 'string' &&
        typeof item.result === 'object' &&
        item.result !== null &&
        typeof item.result.success === 'boolean' &&
        Array.isArray(item.result.articles)
      )
    })
  } catch (err) {
    console.error('Failed to load chat history from localStorage:', err)
    return []
  }
}

function saveHistoryToStorage(history: ChatSession[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
  } catch (err) {
    console.error('Failed to save chat history to localStorage:', err)
  }
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) return dateStr
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return dateStr
  }
}

const BACKEND_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000'
const API_BASE_URL = `${BACKEND_URL}/api/research`

export default function App() {
  const [history, setHistory] = useState<ChatSession[]>(loadHistoryFromStorage)
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ResearchResponse | null>(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)

  const handleNewChat = () => {
    setQuestion('')
    setResult(null)
    setError(null)
    setActiveChatId(null)
    setIsSidebarOpen(false)
  }

  const handleSelectChat = (chat: ChatSession) => {
    setQuestion(chat.question)
    setResult(chat.result)
    setError(null)
    setActiveChatId(chat.id)
    setIsSidebarOpen(false)
  }

  const handleDeleteChat = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setHistory((prev) => {
      const updated = prev.filter((item) => item.id !== id)
      saveHistoryToStorage(updated)
      return updated
    })
    if (activeChatId === id) {
      handleNewChat()
    }
  }

  const handleClearHistory = () => {
    if (window.confirm('Are you sure you want to clear all chat history?')) {
      setHistory([])
      saveHistoryToStorage([])
      handleNewChat()
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const trimmed = question.trim()
    if (!trimmed) {
      setError('Please enter an English medical research question.')
      return
    }

    if (loading) return

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const response = await fetch(API_BASE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ question: trimmed }),
      })

      const data = await response.json().catch(() => null)

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error(
            data?.message ||
              'Gemini API quota exceeded or rate limit reached (HTTP 429). Please try again later.'
          )
        }
        if (response.status === 503) {
          throw new Error(
            data?.message ||
              'Gemini AI is temporarily unavailable due to high demand (HTTP 503). Please try again in a moment.'
          )
        }
        if (response.status === 400) {
          throw new Error(
            data?.message || 'Invalid medical question. Please enter a valid topic.'
          )
        }
        throw new Error(
          data?.message || `Server error (${response.status}): Failed to retrieve research.`
        )
      }

      if (!data || !data.success) {
        throw new Error(data?.message || 'Failed to retrieve research results.')
      }

      setResult(data)

      const newSession: ChatSession = {
        id: Date.now().toString() + '-' + Math.random().toString(36).substring(2, 8),
        question: trimmed,
        createdAt: new Date().toISOString(),
        result: data,
      }

      setHistory((prev) => {
        const updated = [newSession, ...prev]
        saveHistoryToStorage(updated)
        return updated
      })
      setActiveChatId(newSession.id)
    } catch (err: unknown) {
      if (
        err instanceof TypeError &&
        (err.message.toLowerCase().includes('fetch') ||
          err.message.toLowerCase().includes('network') ||
          err.message.toLowerCase().includes('load failed'))
      ) {
        setError(
          `Unable to connect to the backend server. Please verify that the backend is running on ${BACKEND_URL}.`
        )
      } else if (err instanceof Error) {
        setError(err.message)
      } else {
        setError('An unexpected error occurred while processing your research question.')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  return (
    <div className="app-container">
      {/* Mobile Backdrop */}
      {isSidebarOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setIsSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Chat History Sidebar */}
      <aside
        className={`chat-sidebar ${isSidebarOpen ? 'open' : ''}`}
        aria-label="Chat History"
      >
        <div className="sidebar-header">
          <button
            type="button"
            className="btn-new-chat"
            onClick={handleNewChat}
            id="new-chat-button"
          >
            <span className="new-chat-icon" aria-hidden="true">
              +
            </span>
            <span>New Chat</span>
          </button>
        </div>

        <div className="sidebar-history-container">
          <div className="history-section-title">
            <span>Recent Research</span>
            {history.length > 0 && (
              <span className="history-count-badge">{history.length}</span>
            )}
          </div>

          <div className="sidebar-history-list">
            {history.length === 0 ? (
              <div className="history-empty">
                <p>No research history yet.</p>
                <span>Completed research sessions will appear here.</span>
              </div>
            ) : (
              history.map((chat) => (
                <div
                  key={chat.id}
                  className={`history-item ${activeChatId === chat.id ? 'active' : ''}`}
                  onClick={() => handleSelectChat(chat)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleSelectChat(chat)
                    }
                  }}
                  title={chat.question}
                >
                  <div className="history-item-body">
                    <span className="history-item-question">{chat.question}</span>
                    <span className="history-item-date">{formatDate(chat.createdAt)}</span>
                  </div>
                  <button
                    type="button"
                    className="btn-delete-history"
                    onClick={(e) => handleDeleteChat(e, chat.id)}
                    title="Delete research session"
                    aria-label={`Delete ${chat.question}`}
                  >
                    &times;
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {history.length > 0 && (
          <div className="sidebar-footer">
            <button
              type="button"
              className="btn-clear-history"
              onClick={handleClearHistory}
            >
              Clear History
            </button>
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <div className="main-content">
        {/* Mobile Navigation Header */}
        <div className="mobile-nav-bar">
          <button
            type="button"
            className="btn-mobile-sidebar-toggle"
            onClick={() => setIsSidebarOpen((prev) => !prev)}
            aria-label="Toggle chat history"
          >
            <span className="hamburger-icon" aria-hidden="true">
              ☰
            </span>
            <span>History ({history.length})</span>
          </button>
          <button
            type="button"
            className="btn-mobile-new-chat"
            onClick={handleNewChat}
          >
            + New Chat
          </button>
        </div>

        <div className="medical-app">
          <header className="app-header">
            <div className="badge-pill">Scientific Literature Explorer</div>
            <h1 className="app-title">Medical Research AI</h1>
            <p className="app-subtitle">
              Explore peer-reviewed scientific literature and receive
              synthesized, evidence-based educational research summaries.
            </p>
          </header>

          <main className="app-main">
            <section className="search-card">
              <form onSubmit={handleSubmit} className="search-form">
                <label htmlFor="question-input" className="input-label">
                  Medical Research Question
                </label>
                <textarea
                  id="question-input"
                  className="search-textarea"
                  rows={3}
                  placeholder="e.g., What are the latest clinical findings on the efficacy of SGLT2 inhibitors in heart failure patients?"
                  value={question}
                  onChange={(e) => {
                    setQuestion(e.target.value)
                    if (error) setError(null)
                  }}
                  onKeyDown={handleKeyDown}
                  disabled={loading}
                  aria-label="Medical research question"
                />

                <div className="form-actions">
                  <span className="keyboard-hint">
                    Press <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to search
                  </span>
                  <button
                    type="submit"
                    id="research-submit-button"
                    className="btn-research"
                    disabled={loading || !question.trim()}
                  >
                    {loading ? (
                      <>
                        <span className="btn-spinner" aria-hidden="true" />
                        <span>Searching...</span>
                      </>
                    ) : (
                      <span>Research</span>
                    )}
                  </button>
                </div>
              </form>
            </section>

            {error && (
              <section className="alert-box error" role="alert" aria-live="assertive">
                <div className="alert-content">
                  <strong>Error:</strong> {error}
                </div>
              </section>
            )}

            {loading && (
              <section className="loading-card" aria-live="polite">
                <div className="pulsing-spinner" aria-hidden="true" />
                <p className="loading-title">Retrieving scientific articles...</p>
                <p className="loading-subtitle">
                  Synthesizing evidence with Gemini AI. This may take a few seconds.
                </p>
              </section>
            )}

            {result && (
              <section className="results-container">
                {result.count === 0 ? (
                  <div className="alert-box neutral" role="status">
                    <h3 className="empty-title">No Relevant Articles Found</h3>
                    <p className="empty-desc">
                      No scientific articles were found matching &ldquo;{result.question}&rdquo;.
                      Please try rephrasing your question with standard medical keywords or broader search terms.
                    </p>
                  </div>
                ) : (
                  <>
                    {result.answer && (
                      <article className="summary-card">
                        <div className="card-header">
                          <div className="header-badge">AI Evidence Summary</div>
                          <span className="source-count-badge">
                            Based on {result.count} scientific {result.count === 1 ? 'article' : 'articles'}
                          </span>
                        </div>

                        <div className="summary-body">
                          {result.answer.split('\n\n').map((paragraph, idx) => (
                            <p key={idx} className="summary-paragraph">
                              {paragraph}
                            </p>
                          ))}
                        </div>

                        <footer className="summary-disclaimer">
                          <strong>Medical Disclaimer:</strong> This summary is generated from peer-reviewed scientific literature for educational and informational purposes only. It does not constitute individual medical advice, clinical diagnosis, or personalized treatment guidance.
                        </footer>
                      </article>
                    )}

                    <section className="articles-section">
                      <div className="section-title-row">
                        <h2 className="section-title">
                          Retrieved Scientific Articles ({result.count})
                        </h2>
                        <span className="section-subtitle">
                          Verify original peer-reviewed sources
                        </span>
                      </div>

                      <div className="articles-list">
                        {result.articles.map((article) => (
                          <article key={article.pmid} className="article-card">
                            <div className="article-header">
                              <span className="pmid-tag">PMID: {article.pmid}</span>
                              <span className="date-tag">{article.publishedDate}</span>
                            </div>

                            <h3 className="article-title">{article.title}</h3>

                            <p className="article-authors">
                              <strong>Authors:</strong> {article.authors}
                            </p>

                            <p className="article-journal">
                              <strong>Journal:</strong> {article.journal}
                            </p>

                            <div className="article-footer">
                              <a
                                href={article.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="pubmed-link"
                              >
                                View Article &rarr;
                              </a>
                            </div>
                          </article>
                        ))}
                      </div>
                    </section>
                  </>
                )}
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
