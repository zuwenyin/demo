import { logger } from "@vue3-learn/logger"

// const data = { ok: true, text: "Hello, vue3!" } as const
// const data = { foo: true, bar: true } as const
// const data = { foo: 1 } as const
const data = { foo: 1, bar: 2 } as const
// 依赖桶：target -> key -> 副作用函数集合
// 用 WeakMap 持有 target，target 被回收时其依赖也会随之释放，避免内存泄漏
// 注意：必须在使用它的 effect() 之前声明，否则会命中 TDZ 报 "Cannot access 'bucket' before initialization"
const bucket = new WeakMap<Record<string, unknown>, Map<string, Set<Effect>>>()

const obj = new Proxy(data, {
  get(target: Record<string, unknown>, key: string) {
    track(target, key)
    // 用 Reflect 保证 getter 里的 this / receiver 语义正确
    return Reflect.get(target, key)
  },
  set(target: Record<string, unknown>, key: string, value: unknown) {
    const oldValue = target[key]
    Reflect.set(target, key, value)
    // 只有值真正变化时才触发更新，避免无意义的重复执行
    if (!Object.is(oldValue, value)) {
      trigger(target, key)
    }
    return true
  }
})

/**
 * 当前正在执行的副作用函数，用于收集依赖
 */
type EffectOptions = { scheduler?: (fn?: () => void) => void, lazy?: boolean }
type Effect = (() => void) & { deps: Set<() => void>[], options?: EffectOptions }
let activeEffect: Effect | undefined
const effectStack: Effect[] = []
function effect(fn: () => void, options?: EffectOptions) {
  const effectFn: Effect = () => {
    clearup(effectFn)
    activeEffect = effectFn
    effectStack.push(effectFn)
    const res = fn()
    effectStack.pop()
    activeEffect = effectStack[effectStack?.length - 1]
    return res
  }
  effectFn.deps = [];
  effectFn.options = options
  if (!options?.lazy) {
    effectFn()
  } else {
    return effectFn
  }
}

function clearup(effectFn: (() => void) & { deps: Set<() => void>[] }) {
  for (let i = 0; i < effectFn.deps.length; i++) {
    const depSet = effectFn.deps[i]
    // console.log('depSet', depSet);
    depSet.delete(effectFn)
  }
  // effectFn.deps.forEach(depSet => {
  //   console.log('depSet',depSet);
  //   depSet.delete(effectFn)
  // })
  effectFn.deps.length = 0
}

/**
 * 测试基本的响应性
 */
// effect(() => {
//   console.log('effect run');
//   document.body.innerHTML = obj.text;
// });
// setTimeout(() => {
//     obj.text = "Hello, world!";
// }, 1000);
// setTimeout(() => {
//     // 副作用函数中并没有读取 notExist 属性的值
//     obj.notExist = 'hello vue3';
// }, 2000);


/**
 * 测试条件渲染的响应性(副作用函数在执行前应该清除之前的依赖)
 */
// effect(() => {
//   console.log('effect run');
//   document.body.innerHTML = (obj.ok ? obj.text : 'not') as string;
// });
// setTimeout(() => {
//   obj.text = "Hello, world!";
//   obj.ok = false;
// }, 1000);
// setTimeout(() => {
//   obj.text = "Hello, vue3!";
// }, 2000);

/**
 * 测试嵌套 effect 的响应性
 */
// let temp1: boolean | undefined, temp2: boolean | undefined
// effect(function effectFn1() {
//   console.log('effectFn1 执行');
//   effect(function effectFn2() {
//     console.log('effectFn2 执行');
//     temp2 = obj.bar as boolean
//   });
//   temp1 = obj.foo as boolean
// });
// setTimeout(() => {
//   // todo: 该行代码执行会导致，bar内层函数被重复收集依赖（后续触发bar的trigger时会出现重复执行的问题）
//   obj.foo = false
//   obj.bar = false
// }, 1000);
// setTimeout(() => {
//   obj.bar = true
// }, 2000);
// console.log('【bucket】', bucket);

/**
 * 测试无限递归循环问题
 */
// effect(() => {
//   console.log('effect run');

//   (obj.foo as number)++
// })

// setTimeout(() => {
//   obj.foo =3
// }, 1000);

/**
 * 测试可调度性
 */
// 1.执行顺序测试
// effect(() => {
//   console.log(`${obj.foo}`);
// },
//   {
//     scheduler: (fn) => {
//       setTimeout(fn!);
//      }
//   });
// (obj.foo as number)++
// console.log('结束了')

// 2.不展示过渡状态（只关注最终结果）
// 使用调度器立即执行，避免过渡状态
// let isFlushing = false
// const jobQueue = new Set<Effect>()
// function flushJob() {
//   if (isFlushing) return
//   isFlushing = true
//   Promise.resolve().then(() => {
//     jobQueue.forEach(job => job())
//     // jobQueue.clear()
//   }).finally(() => {
//     isFlushing = false
//   })
// }

// effect(() => {
//   console.log(`${obj.foo}`);
// },
//   {
//     scheduler: (fn) => {
//       jobQueue.add(fn as any)
//       flushJob()
//     }
//   });
// (obj.foo as number)++
// (obj.foo as number)++

/**
 * 测试computed计算属性
 */
function computed(getter: () => unknown) {
  let value: any;
  let dirty = true;
  const effectFn = effect(getter, {
    lazy: true,
    // 当依赖发生变化时，标记为脏，但不立即执行，等待下次访问时再计算
    scheduler: () => {
      dirty = true
      logger.label('info', 'computed value invalidated', { color: '#722ed1', text: '#722ed1' }).info(`dirty=> ${dirty}`)
      trigger(computedObj, 'value')
    }
  })

  const computedObj = {
    get value() {
      if (dirty) {
        value = effectFn!()
        dirty = false

        logger.label('info', 'computed value run', { color: '#722ed1', text: '#722ed1' }).info(`dirty=> ${dirty}`)
      }
      track(computedObj, 'value')
      return value
    }
  }
  return computedObj
}
// // 1.正常调用
// const sum = computed(() => (obj.foo as number) + (obj.bar as number))
// // console.log(sum.value)
// // console.log(sum.value)
// // console.log(sum.value)
// // obj.foo = 5
// // obj.bar = 10
// // console.log(sum.value)

// // 2.其他effect函数中使用
// effect(() => {
//   console.log(`effect sum.value=> ${sum.value}`)
// })
// obj.foo = 6

/**
 * 测试watch属性侦听器
 */
interface WatchOptions {
  immediate?: boolean;
  flush?: 'post'
}
function watch(source: any, callback: (newVal: any, oldVal: any) => void, options?: WatchOptions) {
  let getter: () => void;
  let newValue, oldValue: any;
  if (typeof source === 'function') {
    getter = source
  } else {
    getter = () => traverse(source)
  }

  const job = (fn?: () => void) => {
    // 两种调用方式等价
    console.log(watchEffectFn === fn);
    // newValue = fn!()
    newValue = watchEffectFn!()
    callback(newValue, oldValue)
    oldValue = newValue
  }

  const watchEffectFn = effect(getter, {
    lazy: true,
    scheduler: (fn) => {
      if (options?.flush === 'post') {
        const p = Promise.resolve()
        p.then(() => job(fn))
      } else {
        job()
      }
    }
  })

  if (options?.immediate) {
    job()
  } else {
    oldValue = watchEffectFn!()
  }
}

function traverse(obj: any, seen = new Set()) {
  if (typeof obj !== 'object' || obj === null) {
    return
  }
  if (seen.has(obj)) {
    return
  }
  seen.add(obj)
  for (const key in obj) {
    traverse(obj[key], seen)
  }
  return obj
}
// // 测试对象的watch
// watch(obj, (newVal, oldVal) => {
//   logger.label('info', 'watch triggered', { color: '#722ed1', text: '#722ed1' }).info(`newVal=> ${JSON.stringify(newVal)}, oldVal=> ${JSON.stringify(oldVal)}`)
// })
// 测试getter的watch
watch(() => obj.foo, (newVal, oldVal) => {
  logger.label('info', 'watch triggered', { color: '#13c2c2', text: '#13c2c2' }).info(`newVal=> ${JSON.stringify(newVal)}, oldVal=> ${JSON.stringify(oldVal)}`)
})
  ; (obj.foo as number)++
  ; (obj.bar as number)++

function track(target: Record<string, unknown>, key: string) {
  if (!activeEffect) {
    console.log(`no active effect for key: ${key}`);
    return
  }
  let depsMap = bucket.get(target)
  if (!depsMap) {
    bucket.set(target, (depsMap = new Map<string, Set<Effect>>()))
  }

  let deps = depsMap.get(key)
  if (!deps) {
    depsMap.set(key, (deps = new Set<Effect>()))
  }
  deps?.add(activeEffect)
  activeEffect.deps.push(deps)
  logger.label('info', 'tracked').setLevel('info').info(`key=> ${key}`)
  // console.log(`tracked effect for key: ${key}`);
}

function trigger(target: Record<string, unknown>, key: string) {
  const depsMap = bucket.get(target)
  if (!depsMap) {
    return
  }
  const effects = depsMap.get(key)
  const effectsToRun = new Set<Effect>()
  effects?.forEach(effect => {
    if (effect !== activeEffect) {
      effectsToRun.add(effect)
    }
  })
  if (effectsToRun.size) {
    logger.label('success', 'triggered').setLevel('success').success(`key=> ${key}`)
    effectsToRun.forEach(effect => {
      if (effect.options?.scheduler) {
        effect.options.scheduler(effect)
      } else {
        effect()
      }
    })
  }
  // deps && deps.forEach(effect => effect())
}
console.log("------------#Effect Start#------------")