/**
 * Boot smoke: mount the plugin's provider and control service on a bare
 * Cordis context and assert both register. Run with the repo's tsx.
 */
import { Context } from '@deepseek-ai/cordis'
import Provider from '../src/index.ts'
import Control from '../src/control/plugin.ts'

const ctx = new Context()
await ctx.plugin(Provider)
await ctx.plugin(Control, { workspaceRoot: process.cwd() })

console.log('sandbox.confine:', typeof ctx.sandbox?.confine)
console.log('sandboxControl.submit:', typeof ctx.sandboxControl?.submit)
console.log('backend report (linux):', ctx.sandbox.reportForHostPlatform('linux'))
