<script lang="ts">
  import type { AuthoringField } from './scenario-builder-model.ts'
  import { valueAtPath } from './scenario-builder-model.ts'
  let { fields, targetFor, fallbackFor, items = [], packConfig = {}, onchange }: {
    fields: ReadonlyArray<AuthoringField>
    targetFor: (field: AuthoringField) => Record<string, unknown> | undefined
    fallbackFor?: (field: AuthoringField) => unknown
    items?: ReadonlyArray<{ id: string; label: string; type: string }>
    packConfig?: Record<string, unknown>
    onchange: (field: AuthoringField, value: unknown) => void
  } = $props()
  const optionsFor = (field: AuthoringField, target: Record<string, unknown>) => {
    if (field.control.kind !== 'select') return []
    const extra = field.control.extendFromConfig
    const records = extra ? valueAtPath(packConfig, extra.path) : []
    const extended = Array.isArray(records) && extra ? records.map(row => ({ value: String(row[extra.valueKey]), label: String(row[extra.labelKey]) })) : []
    return [...new Map([...field.control.options.filter(option => !option.compatibleWith || option.compatibleWith.values.includes(String(valueAtPath(target, option.compatibleWith.path)))), ...extended].map(option => [option.value, option])).values()]
  }
</script>

{#each fields as field (field.path.join('.'))}
  {@const target = targetFor(field)}
  {#if target}
    {@const current = valueAtPath(target, field.path)}
    {@const shown = current ?? fallbackFor?.(field) ?? field.control.defaultValue}
    <label title={field.description}>{field.label}
      {#if field.control.kind === 'select'}
        <select value={String(shown ?? '')} onchange={event => onchange(field,event.currentTarget.value)}>
          {#if shown === undefined}<option value="">Not set</option>{/if}
          {#if shown !== undefined && !optionsFor(field, target).some(option => option.value === shown)}<option value={String(shown)} disabled>Unavailable: {String(shown)}</option>{/if}
          {#each optionsFor(field, target) as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
        </select>
      {:else if field.control.kind === 'reference'}
        <select value={String(current ?? '')} onchange={event => onchange(field, event.currentTarget.value || undefined)}><option value="">Not set</option>{#each items.filter(item => field.control.kind === 'reference' && (field.control.itemTypes === undefined || field.control.itemTypes.includes(item.type))) as item (item.id)}<option value={item.id}>{item.label}</option>{/each}</select>
      {:else if field.control.kind === 'string-list'}
        <textarea rows="3" value={Array.isArray(shown) ? shown.join('\n') : ''} onchange={event => onchange(field, event.currentTarget.value.split('\n').map(value => value.trim()).filter(Boolean))}></textarea>
      {:else if field.control.kind === 'boolean'}
        <input type="checkbox" checked={Boolean(shown)} onchange={event=>onchange(field,event.currentTarget.checked)} />
      {:else if field.control.kind === 'number'}
        <input type="number" value={shown === undefined ? '' : Number(shown)} min={field.control.min} max={field.control.max} step={field.control.step} onchange={event=>{if(event.currentTarget.value === '' && field.optional)onchange(field,undefined);else if(Number.isFinite(event.currentTarget.valueAsNumber))onchange(field,event.currentTarget.valueAsNumber)}} />
      {:else}
        <input value={String(shown ?? '')} oninput={event=>onchange(field,event.currentTarget.value)} />
      {/if}
    </label>
    {#if field.optional && current !== undefined}<button type="button" class="field-reset" onclick={() => onchange(field, undefined)}>Reset {field.label}</button>{/if}
  {/if}
{/each}
