import * as THREE from 'three/webgpu'
import {
  VFXParticleSystem,
  isNonDefaultRotation,
  updateUniformsPartial,
} from 'core-vfx'
import type { VFXParticleSystemOptions } from 'core-vfx'

export type VFXParticlesOptions = VFXParticleSystemOptions & {
  debug?: boolean
}

// Structural keys that require full system recreation
const STRUCTURAL_KEYS = [
  'maxParticles',
  'lighting',
  'appearance',
  'shadow',
  'orientToDirection',
]

export class VFXParticles {
  readonly group: THREE.Group
  private _renderer: THREE.WebGPURenderer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _config: Record<string, any>
  private _system: VFXParticleSystem | null = null
  private _emitting = true
  private _emitAccumulator = 0
  private _debug: boolean
  private _initialized = false

  constructor(renderer: THREE.WebGPURenderer, options?: VFXParticlesOptions) {
    this._renderer = renderer
    this._debug = options?.debug ?? false
    this._config = { ...options }
    delete this._config.debug
    this.group = new THREE.Group()
  }

  get object3D(): THREE.Group {
    return this.group
  }

  get system(): VFXParticleSystem | null {
    return this._system
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get uniforms(): Record<string, { value: any }> | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this._system
      ? (this._system.uniforms as unknown as Record<string, { value: any }>)
      : null
  }

  get isEmitting(): boolean {
    return this._emitting
  }

  async init(): Promise<void> {
    if (this._initialized) return

    if (this._debug) {
      const { DEFAULT_VALUES } = await import('debug-vfx')
      this._config = { ...DEFAULT_VALUES, ...this._config }
    }

    await this._recreateSystem()
    this._initialized = true

    if (this._debug) {
      const { renderDebugPanel } = await import('debug-vfx')
      renderDebugPanel({ ...this._config }, (newValues: Record<string, unknown>) =>
        this.setProps(newValues)
      )
    }
  }

  update(delta: number): void {
    if (!this._system || !this._system.initialized) return

    // Auto-emission
    if (this._emitting) {
      const delay = this._system.normalizedProps.delay
      const emitCount = this._system.normalizedProps.emitCount
      const [px, py, pz] = this._system.position

      if (!delay) {
        this._system.spawn(px, py, pz, emitCount)
      } else {
        this._emitAccumulator += delta
        if (this._emitAccumulator >= delay) {
          this._emitAccumulator -= delay
          this._system.spawn(px, py, pz, emitCount)
        }
      }
    }

    this._system.update(delta)
  }

  dispose(): void {
    if (this._system) {
      this.group.remove(this._system.renderObject)
      this._system.dispose()
      this._system = null
    }
    if (this._debug) {
      import('debug-vfx').then(({ destroyDebugPanel }) => {
        destroyDebugPanel()
      })
    }
    this._initialized = false
  }

  spawn(
    x = 0,
    y = 0,
    z = 0,
    count?: number,
    overrides?: Record<string, unknown> | null
  ): void {
    if (!this._system) return
    this._system.spawn(
      x,
      y,
      z,
      count ?? this._system.normalizedProps.emitCount,
      overrides ?? null
    )
  }

  start(): void {
    this._emitting = true
    this._emitAccumulator = 0
    if (this._system) this._system.start()
  }

  stop(): void {
    this._emitting = false
    if (this._system) this._system.stop()
  }

  clear(): void {
    if (this._system) this._system.clear()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setProps(newValues: Record<string, any>): void {
    this._config = { ...this._config, ...newValues }

    // Check if any structural key changed
    const needsRecreate = STRUCTURAL_KEYS.some((key) => key in newValues)

    // Feature flags that also require recreation
    if ('turbulence' in newValues) {
      const newHasTurbulence =
        newValues.turbulence !== null &&
        (newValues.turbulence?.intensity ?? 0) > 0
      const oldHasTurbulence = this._system?.features.turbulence ?? false
      if (newHasTurbulence !== oldHasTurbulence) {
        this._recreateSystem()
        return
      }
    }
    if ('attractors' in newValues) {
      const newHasAttractors =
        newValues.attractors !== null && newValues.attractors?.length > 0
      const oldHasAttractors = this._system?.features.attractors ?? false
      if (newHasAttractors !== oldHasAttractors) {
        this._recreateSystem()
        return
      }
    }
    if ('collision' in newValues) {
      const newHasCollision =
        newValues.collision !== null && newValues.collision !== undefined
      const oldHasCollision = this._system?.features.collision ?? false
      if (newHasCollision !== oldHasCollision) {
        this._recreateSystem()
        return
      }
    }
    if ('rotation' in newValues || 'rotationSpeed' in newValues) {
      const rot = this._config.rotation ?? [0, 0]
      const rotSpeed = this._config.rotationSpeed ?? [0, 0]
      const newNeedsRotation =
        isNonDefaultRotation(rot) || isNonDefaultRotation(rotSpeed)
      const oldNeedsRotation = this._system?.features.needsRotation ?? false
      if (newNeedsRotation !== oldNeedsRotation) {
        this._recreateSystem()
        return
      }
    }
    if ('colorStart' in newValues || 'colorEnd' in newValues) {
      const startLen = this._config.colorStart?.length ?? 1
      const hasColorEnd =
        this._config.colorEnd !== null && this._config.colorEnd !== undefined
      const newNeedsPerParticleColor = startLen > 1 || hasColorEnd
      const oldNeedsPerParticleColor =
        this._system?.features.needsPerParticleColor ?? false
      if (newNeedsPerParticleColor !== oldNeedsPerParticleColor) {
        this._recreateSystem()
        return
      }
    }

    // Handle geometry type changes from debug panel
    if ('geometryType' in newValues || 'geometryArgs' in newValues) {
      import('debug-vfx').then(({ createGeometry, GeometryType }) => {
        const geoType = this._config.geometryType
        if (geoType === GeometryType.NONE || !geoType) {
          this._config.geometry = null
        } else {
          this._config.geometry = createGeometry(geoType, this._config.geometryArgs)
        }
        this._recreateSystem()
      })
      return
    }

    if (needsRecreate) {
      this._recreateSystem()
      return
    }

    // Uniform-level updates (no recreation needed)
    this._applyUniformUpdates(newValues)
  }

  private async _recreateSystem(): Promise<void> {
    if (this._system) {
      this.group.remove(this._system.renderObject)
      this._system.dispose()
    }
    const s = new VFXParticleSystem(
      this._renderer,
      this._config as VFXParticleSystemOptions
    )
    await s.init()
    this._system = s
    this.group.add(s.renderObject)
    this._emitAccumulator = 0
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _applyUniformUpdates(newValues: Record<string, any>): void {
    if (!this._system) return

    // Handle colorStart→colorEnd fallback before calling core
    if ('colorStart' in newValues && newValues.colorStart && !this._config.colorEnd) {
      // When colorEnd is null, colorEnd should mirror colorStart
      newValues = { ...newValues, colorEnd: null }
    }
    if ('colorEnd' in newValues && !newValues.colorEnd) {
      newValues = {
        ...newValues,
        colorStart: newValues.colorStart ?? this._config.colorStart ?? ['#ffffff'],
      }
    }

    updateUniformsPartial(this._system.uniforms, newValues)

    // Non-uniform updates
    if (newValues.position) {
      this._system.setPosition(newValues.position)
    }
    if ('delay' in newValues) {
      this._system.setDelay(newValues.delay ?? 0)
    }
    if ('emitCount' in newValues) {
      this._system.setEmitCount(newValues.emitCount ?? 1)
    }
    if (newValues.autoStart !== undefined) {
      this._emitting = newValues.autoStart
      if (this._emitting) this._system.start()
      else this._system.stop()
    }
    if (this._system.material && newValues.blending !== undefined) {
      this._system.material.blending = newValues.blending
      this._system.material.needsUpdate = true
    }
  }
}
