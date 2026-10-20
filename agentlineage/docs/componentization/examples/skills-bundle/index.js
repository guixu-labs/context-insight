import { fileURLToPath } from 'node:url';
import { apply as mountSkills } from '@deepseek-ai/dsh-skill-filesystem';

export const name = 'component-skills-demo';
export const inject = ['skills'];

export function apply(ctx) {
  mountSkills(ctx, {
    providerName: 'team-component-demo-skills',
    includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('./assets/skills/', import.meta.url)),
    watch: false,
  });
}
