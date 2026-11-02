import { useState, useRef, useEffect } from 'react'
import { useT } from '../../../hooks/useT'
import { useResourceWhen } from '../../../hooks/useResource'
import { useSetting } from '../../../hooks/useSetting'
import { useSttStore } from '../../../stores/stt'
import { SETTINGS_KEYS, setSetting, sttStatusResource, runSttTest } from '../../../lib/resources'
import { startAudioCapture, bytesToBase64, type AudioCaptureHandle } from '../../../lib/audio-capture'
import { Button } from '../../shared/Button'
import { Spinner } from '../../shared/Spinner'
import { Toggle } from '../../shared/Toggle'
import { CheckIcon, DownloadIcon, MicIcon, TrashIcon } from '../../shared/icons'

const ENGINES = [
  { id: 'off', en: 'Off', fr: 'Désactivé' },
  { id: 'vosk', en: 'Vosk', fr: 'Vosk' },
  { id: 'whisper', en: 'Whisper', fr: 'Whisper' },
] as const

const WHISPER_SIZES = [
  { id: 'base', en: 'Base', fr: 'Base', hintEn: '160 MB', hintFr: '160 Mo' },
  { id: 'small', en: 'Small', fr: 'Small', hintEn: '375 MB', hintFr: '375 Mo' },
  { id: 'medium', en: 'Medium', fr: 'Medium', hintEn: '946 MB', hintFr: '946 Mo' },
] as const

const VOSK_SIZES = [
  { id: 'small', en: 'Small', fr: 'Small', hintEn: '42 MB', hintFr: '42 Mo' },
  { id: 'large', en: 'Large', fr: 'Large', hintEn: '1.4 GB', hintFr: '1,4 Go' },
] as const

const LANGUAGES = [
  { id: 'fr', en: 'French', fr: 'Français' },
  { id: 'en', en: 'English', fr: 'Anglais' },
  { id: 'auto', en: 'Auto-detect', fr: 'Détection auto' },
] as const

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  }
  return `${Math.round(bytes / 1_000_000)} MB`
}

type SttSizeOption = { id: string; en: string; fr: string; hintEn: string; hintFr: string }

function EngineOptionsSection({
  title,
  description,
  sizes,
  selectedSize,
  onSizeSelect,
  modelLabel,
  downloaded,
  downloadProgress,
  deletingModel,
  onDownload,
  onDelete,
  language,
  onLanguageSelect,
  downloadError,
}: {
  title: string
  description: string
  sizes: readonly SttSizeOption[]
  selectedSize: string
  onSizeSelect: (id: string) => void
  modelLabel: string
  downloaded: boolean
  downloadProgress: number | null
  deletingModel: boolean
  onDownload: () => void
  onDelete: () => void
  language: string
  onLanguageSelect: (id: string) => void
  downloadError: string | null
}) {
  const t = useT()
  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-sm font-medium text-text-primary mb-1">{title}</h3>
      <p className="text-xs text-text-muted mb-4">{description}</p>

      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary font-medium">{t({ en: 'Model size', fr: 'Taille du modèle' })}</div>
        <div className="text-xs text-text-muted mt-0.5">
          {t({
            en: 'Bigger = more accurate, slower, larger',
            fr: 'Plus grand = plus précis, plus lent, plus lourd',
          })}
        </div>
      </div>
      <div className="flex gap-2 mt-3 mb-4">
        {sizes.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSizeSelect(s.id)}
            className={`px-3 py-1.5 rounded text-sm border transition-colors ${
              selectedSize === s.id
                ? 'bg-accent-primary/10 border-accent-primary text-accent-primary'
                : 'border-border text-text-muted hover:text-text-primary'
            }`}
          >
            {t({ en: s.en, fr: s.fr })}
            <span className="ml-1.5 text-xs opacity-70">{t({ en: s.hintEn, fr: s.hintFr })}</span>
          </button>
        ))}
      </div>

      <div className="rounded border border-border bg-bg-tertiary/40 p-3 mb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-text-primary font-medium">{t({ en: 'Model', fr: 'Modèle' })}</div>
            <div className="text-xs text-text-muted mt-0.5">{modelLabel}</div>
          </div>
          {downloaded && downloadProgress === null ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1.5 text-xs text-accent-success">
                <CheckIcon className="w-3.5 h-3.5" />
                {t({ en: 'Downloaded', fr: 'Téléchargé' })}
              </span>
              <button
                type="button"
                onClick={onDelete}
                disabled={deletingModel}
                aria-label={t({ en: 'Delete model', fr: 'Supprimer le modèle' })}
                title={t({ en: 'Delete model', fr: 'Supprimer le modèle' })}
                className="p-1.5 rounded text-text-muted hover:text-accent-error hover:bg-accent-error/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deletingModel ? <Spinner size="sm" className="w-3.5 h-3.5" /> : <TrashIcon className="w-3.5 h-3.5" />}
              </button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={onDownload}
              disabled={downloadProgress !== null || deletingModel}
            >
              {downloadProgress !== null ? (
                <Spinner size="sm" className="w-3.5 h-3.5" />
              ) : (
                <DownloadIcon className="w-3.5 h-3.5" />
              )}
              {t({ en: 'Download', fr: 'Télécharger' })}
            </Button>
          )}
        </div>
        {downloadProgress !== null && (
          <div className="mt-3">
            <div className="h-1 rounded-full bg-accent-primary/20 overflow-hidden">
              <div
                className="h-full bg-accent-primary transition-[width] duration-200"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-text-muted">
              {t(
                { en: 'Downloading… {{percent}}%', fr: 'Téléchargement… {{percent}} %' },
                { percent: Math.round(downloadProgress) },
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-sm text-text-primary font-medium">{t({ en: 'Language', fr: 'Langue' })}</div>
        <div className="text-xs text-text-muted mt-0.5">
          {t({ en: 'Recognition language', fr: 'Langue de reconnaissance' })}
        </div>
      </div>
      <div className="flex gap-2 mt-3">
        {LANGUAGES.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onLanguageSelect(l.id)}
            className={`px-3 py-1.5 rounded text-sm border transition-colors ${
              language === l.id
                ? 'bg-accent-primary/10 border-accent-primary text-accent-primary'
                : 'border-border text-text-muted hover:text-text-primary'
            }`}
          >
            {t({ en: l.en, fr: l.fr })}
          </button>
        ))}
      </div>

      {downloadError && <div className="mt-3 text-xs text-accent-error">{downloadError}</div>}
    </section>
  )
}

export function AudioTab() {
  const t = useT()
  const engine = useSetting(SETTINGS_KEYS.STT_ENGINE, 'off').value
  const whisperModel = useSetting(SETTINGS_KEYS.STT_WHISPER_MODEL, 'small').value
  const voskModel = useSetting(SETTINGS_KEYS.STT_VOSK_MODEL, 'small').value
  const language = useSetting(SETTINGS_KEYS.STT_LANGUAGE, 'fr').value
  const sttDebug = useSetting(SETTINGS_KEYS.STT_DEBUG, 'false').value
  const isWhisper = engine === 'whisper'
  const isVosk = engine === 'vosk'
  const { data: sttStatus, loading: statusLoading } = useResourceWhen(
    engine !== 'off',
    sttStatusResource,
    whisperModel,
    voskModel,
  )
  const downloadProgress = useSttStore((s) => s.downloadProgress)
  const downloadWsError = useSttStore((s) => s.downloadError)
  const downloaded = useSttStore((s) => s.downloaded)
  const startModelDownload = useSttStore((s) => s.startModelDownload)
  const clearDownloadResult = useSttStore((s) => s.clearDownloadResult)
  const deletingModel = useSttStore((s) => s.deletingModel)
  const deleteModel = useSttStore((s) => s.deleteModel)
  const deleted = useSttStore((s) => s.deleted)
  const clearDeleteResult = useSttStore((s) => s.clearDeleteResult)
  const [recording, setRecording] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const captureRef = useRef<AudioCaptureHandle | null>(null)
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (testTimerRef.current) {
        clearTimeout(testTimerRef.current)
        testTimerRef.current = null
      }
      captureRef.current?.stop()
      captureRef.current = null
    }
  }, [])

  const handleEngine = (id: string): void => {
    void setSetting(SETTINGS_KEYS.STT_ENGINE, id)
  }
  const handleModel = (id: string): void => {
    void setSetting(SETTINGS_KEYS.STT_WHISPER_MODEL, id)
  }
  const handleVoskModel = (id: string): void => {
    void setSetting(SETTINGS_KEYS.STT_VOSK_MODEL, id)
  }
  const handleLanguage = (id: string): void => {
    void setSetting(SETTINGS_KEYS.STT_LANGUAGE, id)
  }
  const handleSttDebug = (): void => {
    void setSetting(SETTINGS_KEYS.STT_DEBUG, sttDebug === 'true' ? 'false' : 'true')
  }
  useEffect(() => {
    if (!downloaded) return
    void sttStatusResource.refresh(whisperModel, voskModel)
    clearDownloadResult()
  }, [downloaded, whisperModel, voskModel, clearDownloadResult])

  useEffect(() => {
    if (!deleted) return
    void sttStatusResource.refresh(whisperModel, voskModel)
    clearDeleteResult()
  }, [deleted, whisperModel, voskModel, clearDeleteResult])

  const handleTest = async (): Promise<void> => {
    if (recording) {
      captureRef.current?.stop()
      captureRef.current = null
      setRecording(false)
      return
    }
    setTesting(true)
    setTestResult(null)
    setTestError(null)
    const chunks: Int16Array[] = []
    let handle: AudioCaptureHandle
    try {
      handle = await startAudioCapture((samples) => {
        chunks.push(samples)
      })
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err))
      setTesting(false)
      return
    }
    captureRef.current = handle
    setRecording(true)
    testTimerRef.current = setTimeout(() => {
      testTimerRef.current = null
      handle.stop()
      captureRef.current = null
      setRecording(false)
      const total = chunks.reduce((sum, c) => sum + c.length, 0)
      const pcm = new Int16Array(total)
      let offset = 0
      for (const c of chunks) {
        pcm.set(c, offset)
        offset += c.length
      }
      runSttTest(bytesToBase64(new Uint8Array(pcm.buffer)))
        .then((res) => setTestResult(res.text))
        .catch((err) => setTestError(err instanceof Error ? err.message : String(err)))
        .finally(() => setTesting(false))
    }, 3000)
  }

  const modelLabel =
    statusLoading && !sttStatus
      ? t({ en: 'Checking…', fr: 'Vérification…' })
      : `${sttStatus?.whisper.file ?? ''} · ${formatBytes(sttStatus?.whisper.bytes ?? 0)}`
  const voskModelLabel =
    statusLoading && !sttStatus
      ? t({ en: 'Checking…', fr: 'Vérification…' })
      : `${sttStatus?.vosk.file ?? ''} · ${formatBytes(sttStatus?.vosk.bytes ?? 0)}`

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-medium text-text-primary mb-1">
          {t({ en: 'Dictation (STT)', fr: 'Dictée (STT)' })}
        </h3>
        <p className="text-xs text-text-muted mb-4">
          {t({
            en: 'Turn your voice into text in the composer. Choose the engine to use.',
            fr: 'Transforme votre voix en texte dans le champ de saisie. Choisissez le moteur à utiliser.',
          })}
        </p>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-text-primary font-medium">{t({ en: 'Engine', fr: 'Moteur' })}</div>
          <div className="text-xs text-text-muted mt-0.5">
            {t({
              en: 'Vosk = real-time · Whisper = more accurate (live, segmented)',
              fr: 'Vosk = temps réel · Whisper = plus précis (live, segmenté)',
            })}
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          {ENGINES.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => handleEngine(e.id)}
              className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                engine === e.id
                  ? 'bg-accent-primary/10 border-accent-primary text-accent-primary'
                  : 'border-border text-text-muted hover:text-text-primary'
              }`}
            >
              {t({ en: e.en, fr: e.fr })}
            </button>
          ))}
        </div>
      </section>

      {engine !== 'off' && (
        <section className="border-t border-border pt-4">
          <h3 className="text-sm font-medium text-text-primary mb-1">
            {t({ en: 'Test microphone', fr: 'Tester le micro' })}
          </h3>
          <p className="text-xs text-text-muted mb-3">
            {t({
              en: 'Record 3 seconds of audio and transcribe it with the selected engine.',
              fr: 'Enregistrez 3 secondes d’audio et transcrivez-les avec le moteur sélectionné.',
            })}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void handleTest()} disabled={testing && !recording}>
            {recording ? (
              <span className="w-3.5 h-3.5 rounded-full bg-accent-error animate-pulse" />
            ) : testing ? (
              <Spinner size="sm" className="w-3.5 h-3.5" />
            ) : (
              <MicIcon className="w-3.5 h-3.5" />
            )}
            {recording
              ? t({ en: 'Recording…', fr: 'Enregistrement…' })
              : testing
                ? t({ en: 'Transcribing…', fr: 'Transcription…' })
                : t({ en: 'Test dictation', fr: 'Tester la dictée' })}
          </Button>
          {testResult !== null && (
            <div className="mt-3 p-2 bg-accent-success/10 border border-accent-success/30 rounded text-sm text-accent-success">
              <span className="text-xs font-medium block mb-1">{t({ en: 'Transcript', fr: 'Transcription' })}</span>
              {testResult}
            </div>
          )}
          {testError !== null && <div className="mt-3 text-xs text-accent-error">{testError}</div>}
        </section>
      )}

      {engine !== 'off' && (
        <section className="border-t border-border pt-4">
          <h3 className="text-sm font-medium text-text-primary mb-1">{t({ en: 'Debug', fr: 'Débogage' })}</h3>
          <p className="text-xs text-text-muted mb-3">
            {t({
              en: 'Log STT events to the browser console (F12) to troubleshoot dictation.',
              fr: 'Journalise les événements STT dans la console du navigateur (F12) pour dépanner la dictée.',
            })}
          </p>
          <div className="flex items-center justify-between">
            <div className="text-sm text-text-primary font-medium">
              {t({ en: 'Debug logs', fr: 'Journaux de débogage' })}
            </div>
            <Toggle
              enabled={sttDebug === 'true'}
              onClick={handleSttDebug}
              label={t({ en: 'Debug logs', fr: 'Journaux de débogage' })}
            />
          </div>
        </section>
      )}

      {isVosk && (
        <EngineOptionsSection
          title={t({ en: 'Vosk options', fr: 'Options Vosk' })}
          description={t({
            en: 'Only applied when the Vosk engine is active.',
            fr: 'Uniquement appliqué si le moteur Vosk est actif.',
          })}
          sizes={VOSK_SIZES}
          selectedSize={voskModel}
          onSizeSelect={handleVoskModel}
          modelLabel={voskModelLabel}
          downloaded={sttStatus?.vosk.downloaded === true}
          downloadProgress={downloadProgress}
          deletingModel={deletingModel}
          onDownload={() => startModelDownload(voskModel)}
          onDelete={() => deleteModel(voskModel)}
          language={language}
          onLanguageSelect={handleLanguage}
          downloadError={downloadWsError}
        />
      )}

      {isWhisper && (
        <EngineOptionsSection
          title={t({ en: 'Whisper options', fr: 'Options Whisper' })}
          description={t({
            en: 'Only applied when the Whisper engine is active.',
            fr: 'Uniquement appliqué si le moteur Whisper est actif.',
          })}
          sizes={WHISPER_SIZES}
          selectedSize={whisperModel}
          onSizeSelect={handleModel}
          modelLabel={modelLabel}
          downloaded={sttStatus?.whisper.downloaded === true}
          downloadProgress={downloadProgress}
          deletingModel={deletingModel}
          onDownload={() => startModelDownload(whisperModel)}
          onDelete={() => deleteModel(whisperModel)}
          language={language}
          onLanguageSelect={handleLanguage}
          downloadError={downloadWsError}
        />
      )}
    </div>
  )
}
