/** TFJS backend initialization and customization */

import type { Human, Config } from '../human';
import { log, now } from '../util/util';
import { env } from '../util/env';
import * as humangl from './humangl';
import * as tf from '../../dist/tfjs.esm.js';
import * as constants from './constants';

function registerCustomOps(config: Config) {
  if (!env.kernels.includes('mod')) {
    const kernelMod = {
      kernelName: 'Mod',
      backendName: tf.getBackend(),
      kernelFunc: (op) => tf.tidy(() => tf.sub(op.inputs.a, tf.mul(tf.div(op.inputs.a, op.inputs.b), op.inputs.b))),
    };
    if (config.debug) log('registered kernel:', 'Mod');
    tf.registerKernel(kernelMod);
    env.kernels.push('mod');
  }
  if (!env.kernels.includes('floormod')) {
    const kernelFloorMod = {
      kernelName: 'FloorMod',
      backendName: tf.getBackend(),
      kernelFunc: (op) => tf.tidy(() => tf.add(tf.mul(tf.floorDiv(op.inputs.a / op.inputs.b), op.inputs.b), tf.mod(op.inputs.a, op.inputs.b))),
    };
    if (config.debug) log('registered kernel:', 'FloorMod');
    tf.registerKernel(kernelFloorMod);
    env.kernels.push('floormod');
  }
  /*
  if (!env.kernels.includes('atan2') && config.softwareKernels) {
    const kernelAtan2 = {
      kernelName: 'Atan2',
      backendName: tf.getBackend(),
      kernelFunc: (op) => tf.tidy(() => {
        const backend = tf.getBackend();
        tf.setBackend('cpu');
        const t = tf.atan2(op.inputs.a, op.inputs.b);
        tf.setBackend(backend);
        return t;
      }),
    };
    if (config.debug) log('registered kernel:', 'atan2');
    log('registered kernel:', 'atan2');
    tf.registerKernel(kernelAtan2);
    env.kernels.push('atan2');
  }
  */
  if (!env.kernels.includes('rotatewithoffset') && config.softwareKernels) {
    const kernelRotateWithOffset = {
      kernelName: 'RotateWithOffset',
      backendName: tf.getBackend(),
      kernelFunc: (op) => tf.tidy(() => {
        const backend = tf.getBackend();
        tf.setBackend('cpu');
        const t = tf.image.rotateWithOffset(op.inputs.image, op.attrs.radians, op.attrs.fillValue, op.attrs.center);
        tf.setBackend(backend);
        return t;
      }),
    };
    if (config.debug) log('registered kernel:', 'RotateWithOffset');
    tf.registerKernel(kernelRotateWithOffset);
    env.kernels.push('rotatewithoffset');
  }
}

export async function check(instance: Human, force = false) {
  instance.state = 'backend';
  if (force || env.initial || (instance.config.backend && (instance.config.backend.length > 0) && (tf.getBackend() !== instance.config.backend))) {
    const timeStamp = now();

    if (instance.config.backend && instance.config.backend.length > 0) {
      // detect web worker
      // @ts-ignore ignore missing type for WorkerGlobalScope as that is the point
      if (typeof window === 'undefined' && typeof WorkerGlobalScope !== 'undefined' && instance.config.debug) {
        if (instance.config.debug) log('running inside web worker');
      }

      // force browser vs node backend
      if (env.browser && instance.config.backend === 'tensorflow') {
        if (instance.config.debug) log('override: backend set to tensorflow while running in browser');
        instance.config.backend = 'humangl';
      }
      if (env.node && (instance.config.backend === 'webgl' || instance.config.backend === 'humangl')) {
        if (instance.config.debug) log(`override: backend set to ${instance.config.backend} while running in nodejs`);
        instance.config.backend = 'tensorflow';
      }

      // handle webgpu
      if (env.browser && instance.config.backend === 'webgpu') {
        if (typeof navigator === 'undefined' || typeof navigator.gpu === 'undefined') {
          log('override: backend set to webgpu but browser does not support webgpu');
          instance.config.backend = 'humangl';
        } else {
          const adapter = await navigator.gpu.requestAdapter();
          if (instance.config.debug) log('enumerated webgpu adapter:', adapter);
          if (!adapter) {
            log('override: backend set to webgpu but browser reports no available gpu');
            instance.config.backend = 'humangl';
          } else {
            // @ts-ignore requestAdapterInfo is not in tslib
            const adapterInfo = 'requestAdapterInfo' in adapter ? await (adapter as GPUAdapter).requestAdapterInfo() : undefined;
            // if (adapter.features) adapter.features.forEach((feature) => log('webgpu features:', feature));
            log('webgpu adapter info:', adapterInfo);
          }
        }
      }

      // check available backends
      if (instance.config.backend === 'humangl') humangl.register(instance);
      const available = Object.keys(tf.engine().registryFactory as Record<string, unknown>);
      if (instance.config.debug) log('available backends:', available);

      if (!available.includes(instance.config.backend)) {
        log(`error: backend ${instance.config.backend} not found in registry`);
        instance.config.backend = env.node ? 'tensorflow' : 'webgl';
        if (instance.config.debug) log(`override: setting backend ${instance.config.backend}`);
      }

      if (instance.config.debug) log('setting backend:', instance.config.backend);

      // customize wasm
      if (instance.config.backend === 'wasm') {
        if (instance.config.debug) log('backend wasm: set custom params');
        if (tf.env().flagRegistry.CANVAS2D_WILL_READ_FREQUENTLY) tf.env().set('CANVAS2D_WILL_READ_FREQUENTLY', true);
        if (instance.config.debug) log('wasm path:', instance.config.wasmPath);
        if (typeof tf.setWasmPaths !== 'undefined') tf.setWasmPaths(instance.config.wasmPath, instance.config.wasmPlatformFetch);
        else throw new Error('backend error: attempting to use wasm backend but wasm path is not set');
        let mt = false;
        let simd = false;
        try {
          mt = await tf.env().getAsync('WASM_HAS_MULTITHREAD_SUPPORT');
          simd = await tf.env().getAsync('WASM_HAS_SIMD_SUPPORT');
          if (instance.config.debug) log(`wasm execution: ${simd ? 'simd' : 'no simd'} ${mt ? 'multithreaded' : 'singlethreaded'}`);
          if (instance.config.debug && !simd) log('warning: wasm simd support is not enabled');
        } catch {
          log('wasm detection failed');
        }
      }

      try {
        await tf.setBackend(instance.config.backend);
        await tf.ready();
        constants.init();
      } catch (err) {
        log('error: cannot set backend:', instance.config.backend, err);
        return false;
      }
    }

    // customize humangl
    if (tf.getBackend() === 'humangl') {
      if (instance.config.debug) log('backend humangl: set custom params');
      if (tf.env().flagRegistry.WEBGL_USE_SHAPES_UNIFORMS) tf.env().set('WEBGL_USE_SHAPES_UNIFORMS', true); // default=false <https://github.com/tensorflow/tfjs/issues/5205>
      if (tf.env().flagRegistry.WEBGL_EXP_CONV) tf.env().set('WEBGL_EXP_CONV', true); // default=false <https://github.com/tensorflow/tfjs/issues/6678>
      // if (tf.env().flagRegistry['WEBGL_PACK_DEPTHWISECONV'])  tf.env().set('WEBGL_PACK_DEPTHWISECONV', false); // default=true <https://github.com/tensorflow/tfjs/pull/4909>
      // if (tf.env().flagRegistry.USE_SETTIMEOUTCUSTOM) tf.env().set('USE_SETTIMEOUTCUSTOM', true); // default=false <https://github.com/tensorflow/tfjs/issues/6687>
      // if (tf.env().flagRegistry.CPU_HANDOFF_SIZE_THRESHOLD) tf.env().set('CPU_HANDOFF_SIZE_THRESHOLD', 1024); // default=1000
      // if (tf.env().flagRegistry['WEBGL_FORCE_F16_TEXTURES'] && !instance.config.object.enabled) tf.env().set('WEBGL_FORCE_F16_TEXTURES', true); // safe to use 16bit precision
      if (typeof instance.config.deallocate !== 'undefined' && instance.config.deallocate) { // hidden param
        log('changing webgl: WEBGL_DELETE_TEXTURE_THRESHOLD:', true);
        tf.env().set('WEBGL_DELETE_TEXTURE_THRESHOLD', 0);
      }
      if (tf.backend().getGPGPUContext) {
        const gl = await tf.backend().getGPGPUContext().gl;
        if (instance.config.debug) log(`gl version:${gl.getParameter(gl.VERSION) as string} renderer:${gl.getParameter(gl.RENDERER) as string}`);
      }
    }

    // customize webgpu
    if (tf.getBackend() === 'webgpu') {
      if (instance.config.debug) log('backend webgpu: set custom params');
      // if (tf.env().flagRegistry['WEBGPU_CPU_HANDOFF_SIZE_THRESHOLD']) tf.env().set('WEBGPU_CPU_HANDOFF_SIZE_THRESHOLD', 512);
      // if (tf.env().flagRegistry['WEBGPU_DEFERRED_SUBMIT_BATCH_SIZE']) tf.env().set('WEBGPU_DEFERRED_SUBMIT_BATCH_SIZE', 0);
      // if (tf.env().flagRegistry['WEBGPU_CPU_FORWARD']) tf.env().set('WEBGPU_CPU_FORWARD', true);
    }

    // wait for ready
    tf.enableProdMode();
    await tf.ready();

    instance.performance.initBackend = Math.trunc(now() - timeStamp);
    instance.config.backend = tf.getBackend();

    await env.updateBackend(); // update env on backend init
    registerCustomOps(instance.config);
    // await env.updateBackend(); // update env on backend init
  }
  return true;
}

// register fake missing tfjs ops
export function fakeOps(kernelNames: string[], config) {
  // if (config.debug) log('registerKernel:', kernelNames);
  for (const kernelName of kernelNames) {
    const kernelConfig = {
      kernelName,
      backendName: config.backend,
      kernelFunc: () => { if (config.debug) log('kernelFunc', kernelName, config.backend); },
      // setupFunc: () => { if (config.debug) log('kernelFunc', kernelName, config.backend); },
      // disposeFunc: () => { if (config.debug) log('kernelFunc', kernelName, config.backend); },
    };
    tf.registerKernel(kernelConfig);
  }
  env.kernels = tf.getKernelsForBackend(tf.getBackend()).map((kernel) => (kernel.kernelName as string).toLowerCase()); // re-scan registered ops
}
