import { useEffect, useState } from 'react'
import { Ipc } from '@shared/channels'
import { editProtocols, type ImageEditChannel } from '@shared/schemas'
import { Field, Input, Select } from '../../components/form'
import { Button, Section } from '../../components/ui'
import { Notice } from '../../components/common/Notice'
import { call } from '../../lib/api'

const empty = { id: '', name: '', protocol: editProtocols[0] as ImageEditChannel['protocol'], baseUrl: '', model: '' }
export function ImageEditSettings() {
  const [rows, setRows] = useState<ImageEditChannel[]>([]),
    [form, setForm] = useState(empty),
    [key, setKey] = useState<string | null>(''),
    [models, setModels] = useState<string[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const select = (c?: ImageEditChannel) => {
    setForm(c ?? empty)
    setKey('')
    setModels([])
    setError('')
  }
  useEffect(() => {
    void call<ImageEditChannel[]>(Ipc.imageEditChannelsList)
      .then(setRows)
      .catch(() => setError('无法读取渠道'))
  }, [])
  const change = (field: string, value: string) => {
    if (
      field === 'baseUrl' &&
      (!URL.canParse(value) || !URL.canParse(form.baseUrl) || new URL(value).origin !== new URL(form.baseUrl).origin)
    )
      setKey('')
    setForm({ ...form, [field]: value })
    if (field !== 'model') setModels([])
  }
  const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }))
  const matches = models.filter((m) => models.includes(form.model) || m.toLowerCase().includes(form.model.toLowerCase()))
  const draft = { id: form.id || undefined, protocol: form.protocol, baseUrl: form.baseUrl, apiKey: key === '' ? undefined : key }
  async function action(kind: 'save' | 'probe' | 'remove') {
    setBusy(true)
    setError('')
    try {
      if (kind === 'probe') {
        setModels(await call<string[]>(Ipc.imageEditDiscoverModels, draft))
        return
      }
      if (kind === 'remove') {
        await call(Ipc.imageEditChannelsRemove, { id: form.id })
        select()
      } else select(await call<ImageEditChannel>(Ipc.imageEditChannelsSave, { ...draft, name: form.name, model: form.model }))
      setRows(await call<ImageEditChannel[]>(Ipc.imageEditChannelsList))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="重绘渠道">
      <fieldset disabled={busy} className="grid gap-3">
        <Field label="选择渠道">
          <Select
            value={form.id}
            onValueChange={(id) => select(rows.find((c) => c.id === id))}
            options={[{ value: '', label: '新渠道' }, ...rows.map((c) => ({ value: c.id, label: c.name }))]}
          />
        </Field>
        <Field label="渠道名称">
          <Input value={form.name} onChange={(e) => change('name', e.target.value)} />
        </Field>
        <Field label="协议">
          <Select value={form.protocol} onValueChange={(v) => change('protocol', v)} options={options(editProtocols)} />
        </Field>
        <Field label="接口地址">
          <Input value={form.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => change('baseUrl', e.target.value)} />
        </Field>
        <Field label="API Key">
          <Input
            type="password"
            autoComplete="off"
            value={key ?? ''}
            placeholder={key === null ? '保存时清空' : '留空保留同一站点的密钥'}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        {rows.find((c) => c.id === form.id)?.hasKey && (
          <Button tone="ghost" onClick={() => setKey(null)}>
            清空密钥
          </Button>
        )}
        <Field label="模型名">
          <Input value={form.model} onChange={(e) => change('model', e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <Button onClick={() => void action('probe')}>探测模型</Button>
          <Button tone="primary" onClick={() => void action('save')}>
            保存渠道
          </Button>
          {form.id && (
            <Button tone="ghost" onClick={() => void action('remove')}>
              移除渠道
            </Button>
          )}
        </div>
        {!!models.length && (
          <Field label="探测结果">
            <Select
              value={models.includes(form.model) ? form.model : ''}
              onValueChange={(v) => change('model', v)}
              options={[{ value: '', label: '选择模型' }, ...options(matches)]}
            />
          </Field>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </fieldset>
    </Section>
  )
}
