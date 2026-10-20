import { useState } from 'react'
import { useT } from '../../../hooks/useT'
import { useResourceWhen } from '../../../hooks/useResource'
import { useSetting } from '../../../hooks/useSetting'
import { SETTINGS_KEYS, setSetting, sttStatusResource, downloadSttWhisperModel } from '../../../lib/resources'
import { Button } from '../../shared/Button'
import { Spinner } from '../../shared/Spinner'
import { CheckIcon, DownloadIcon } from '../../shared/icons'

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

export function AudioTab() {
  const t = useT()
  const engine = useSetting(SETTINGS_KEYS.STT_ENGINE, 'off').value
  const whisperModel = useSetting(SETTINGS_KEYS.STT_WHISPER_MODEL, 'small').value
  const language = useSetting(SETTINGS_KEYS.STT_LANGUAGE, 'fr').value
  const isWhisper = engine === 'whisper'
  const { data: sttStatus, loading: statusLoading } = useResourceWhen(isWhisper, sttStatusResource, whisperModel)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const handleEngine = (id: string): void => {
    void setSetting(SETTINGS_KEYS.STT_ENGINE, id)
  }
  const handleModel = (id: string): void => {
    void setSetting(SETTINGS_KEYS.STT_WHISPER_MODEL, id)
  }
  const handleLanguage = (id: string): void => {
    void setSetting(SETTINGS_KEYS.STT_LANGUAGE, id)
  }
  const handleDownload = async (): Promise<void> => {
    setDownloading(true)
    setDownloadError(null)
    try {
      await downloadSttWhisperModel(whisperModel)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err))
    } finally {
      setDownloading(false)
    }
  }

  const modelLabel =
    statusLoading && !sttStatus
      ? t({ en: 'Checking…', fr: 'Vérification…' })
      : `${sttStatus?.whisper.file ?? ''} · ${formatBytes(sttStatus?.whisper.bytes ?? 0)}`

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

      {isWhisper && (
        <section className="border-t border-border pt-4">
          <h3 className="text-sm font-medium text-text-primary mb-1">
            {t({ en: 'Whisper options', fr: 'Options Whisper' })}
          </h3>
          <p className="text-xs text-text-muted mb-4">
            {t({
              en: 'Only applied when the Whisper engine is active.',
              fr: 'Uniquement appliqué si le moteur Whisper est actif.',
            })}
          </p>

          <div className="flex-1 min-w-0">
            <div className="text-sm text-text-primary font-medium">
              {t({ en: 'Model size', fr: 'Taille du modèle' })}
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              {t({
                en: 'Bigger = more accurate, slower, larger',
                fr: 'Plus grand = plus précis, plus lent, plus lourd',
              })}
            </div>
          </div>
          <div className="flex gap-2 mt-3 mb-4">
            {WHISPER_SIZES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => handleModel(s.id)}
                className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                  whisperModel === s.id
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
              {sttStatus?.whisper.downloaded ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-accent-success">
                  <CheckIcon className="w-3.5 h-3.5" />
                  {t({ en: 'Downloaded', fr: 'Téléchargé' })}
                </span>
              ) : (
                <Button size="sm" variant="secondary" onClick={handleDownload} disabled={downloading}>
                  {downloading ? (
                    <Spinner size="sm" className="w-3.5 h-3.5" />
                  ) : (
                    <DownloadIcon className="w-3.5 h-3.5" />
                  )}
                  {t({ en: 'Download', fr: 'Télécharger' })}
                </Button>
              )}
            </div>
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
                onClick={() => handleLanguage(l.id)}
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
      )}
    </div>
  )
}
