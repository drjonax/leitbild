import { processLinkVariablePath, type ProcessLinkBehaviorDefinition } from '../behavior-contract.ts'
import { sourcePowerForComponent } from '../behaviors/electrical-behaviors.ts'

// A power line carries power while the equipment feeding it puts power out,
// as that equipment's solved state reads: a breaker's line is dead while its
// contacts are open, whatever its command says. Solved after the electrical
// phase, so it reads the same tick's sources.
export const processLinkElectricalBehaviorDefinitions: ReadonlyArray<ProcessLinkBehaviorDefinition> = [
  {
    id: 'process-link-electrical-energized',
    phase: 'updateProcessLinkState',
    reads: ['source component energized state'],
    writes: ['energized'],
    appliesTo: (link): boolean => link.kind === 'electricalPower',
    update: ({ system, link, context }): void => {
      const source = system.graph.components[link.fromComponentIndex]
      if (!source) throw new Error(`process link ${link.id} references missing component`)
      context.write(processLinkVariablePath(link, 'energized'), sourcePowerForComponent(source, context).energized)
    },
  },
]
