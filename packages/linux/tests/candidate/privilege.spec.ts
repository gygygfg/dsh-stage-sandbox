import { describe, expect, it } from 'vitest'
import { classifyPrivilege } from '../../src/candidate/privilege.ts'

describe('privilege tiers', () => {
  it('classifies ordinary commands as T0', () => {
    expect(classifyPrivilege('ls -la').tier).toBe('T0')
    expect(classifyPrivilege('echo hi && cat a.txt').tier).toBe('T0')
  })

  it('classifies package installs and containers as T1', () => {
    expect(classifyPrivilege('pip install requests').tier).toBe('T1')
    expect(classifyPrivilege('docker run alpine').tier).toBe('T1')
    expect(classifyPrivilege('git push origin main').tier).toBe('T1')
  })

  it('classifies host/kernel state as T2, wrapping included', () => {
    expect(classifyPrivilege('mount /dev/sda1 /mnt').tier).toBe('T2')
    expect(classifyPrivilege('modprobe nvidia').tier).toBe('T2')
    expect(classifyPrivilege('sysctl net.ipv4.ip_forward=1').tier).toBe('T2')
    const wrapped = classifyPrivilege('sudo mount /dev/sda1 /mnt')
    expect(wrapped.tier).toBe('T2')
    expect(wrapped.elevated).toBe(true)
  })

  it('flags a privilege wrapper without raising the tier of a T0 command', () => {
    const assessment = classifyPrivilege('sudo -u postgres ls')
    expect(assessment.tier).toBe('T0')
    expect(assessment.elevated).toBe(true)
  })

  it('treats a read-only sysctl as T0', () => {
    expect(classifyPrivilege('sysctl -a').tier).toBe('T0')
  })
})
