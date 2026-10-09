// Show gate: loaded into the agent browser's main process (macOS only).
//
// The browser runs out of sight (window minimized, app hidden). Anything that
// makes Chrome order a window in or activate itself (a page's window.open, a
// popup, window.focus(), a PDF viewer, a new tab brought forward) makes AppKit
// unhide the app: the user sees the browser flash. Instead of undoing that
// afterwards, the gate stops it here, where every such path ends up.
//
// A call that would show the app passes only when
// - the gateway opened the gate for a user request: the file named by
//   AGENTIC_SHOW_GATE holds a deadline (ms since epoch) in the future, or
// - the user already brought the app forward themselves (Dock, Cmd-Tab):
//   the app is active and not hidden.
// Everything else (hiding, minimizing, ordering out, creating windows) is left
// alone.
//
// The methods are gated on NSApplication / NSWindow / NSRunningApplication and
// on every subclass that overrides them, including classes in images loaded
// later (Chrome's framework is loaded after this library).
//
// Optional: AGENTIC_SHOW_GATE_LOG names a file that gets one line per blocked
// call, for diagnostics.
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <sys/time.h>

static char *gatePath;
static char *logPath;
static atomic_long blockedCount;

static long long nowMs(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

static BOOL gateOpen(void) {
  FILE *f = fopen(gatePath, "r");
  if (!f)
    return NO;
  long long deadline = 0;
  int n = fscanf(f, "%lld", &deadline);
  fclose(f);
  return n == 1 && deadline > nowMs();
}

static BOOL userHasApp(void) {
  NSApplication *app = NSApp;
  return app && app.isActive && !app.isHidden;
}

static BOOL allowed(const char *cls, const char *sel) {
  if (userHasApp() || gateOpen())
    return YES;
  long count = atomic_fetch_add(&blockedCount, 1) + 1;
  if (logPath) {
    FILE *f = fopen(logPath, "a");
    if (f) {
      fprintf(f, "%lld blocked -[%s %s] (#%ld)\n", nowMs(), cls, sel, count);
      fclose(f);
    }
  }
  return NO;
}

typedef enum { kVoid, kVoidBool, kVoidId, kRunningActivate, kOrderWindow } Kind;
typedef struct { const char *sel; Kind kind; } Gated;

// Per base class: the selectors that can show the app.
static const Gated appSels[] = {
  {"activateIgnoringOtherApps:", kVoidBool}, {"activate", kVoid}, {"unhide:", kVoidId},
  {"unhideWithoutActivation", kVoid}, {"arrangeInFront:", kVoidId},
};
static const Gated windowSels[] = {
  {"orderWindow:relativeTo:", kOrderWindow}, {"orderFrontRegardless", kVoid},
  {"deminiaturize:", kVoidId}, {"makeKeyAndOrderFront:", kVoidId}, {"orderFront:", kVoidId},
};
static const Gated runningSels[] = {{"activateWithOptions:", kRunningActivate}};

static BOOL ownsMethod(Class cls, SEL sel) {
  unsigned count = 0;
  Method *list = class_copyMethodList(cls, &count);
  BOOL found = NO;
  for (unsigned i = 0; i < count && !found; i++)
    found = method_getName(list[i]) == sel;
  free(list);
  return found;
}

// Each hooked (class, selector) gets its own block holding that class's
// original implementation, so a subclass override calling super reaches the
// right original.
static void hookOne(Class cls, const Gated *g) {
  SEL sel = sel_registerName(g->sel);
  if (!ownsMethod(cls, sel))
    return;
  Method m = class_getInstanceMethod(cls, sel);
  IMP orig = method_getImplementation(m);
  const char *cname = class_getName(cls);
  const char *sname = g->sel;
  id block = nil;
  switch (g->kind) {
    case kVoid:
      block = ^(id self) {
        if (allowed(cname, sname))
          ((void (*)(id, SEL))orig)(self, sel);
      };
      break;
    case kVoidBool:
      block = ^(id self, BOOL flag) {
        if (allowed(cname, sname))
          ((void (*)(id, SEL, BOOL))orig)(self, sel, flag);
      };
      break;
    case kVoidId:
      block = ^(id self, id arg) {
        if (allowed(cname, sname))
          ((void (*)(id, SEL, id))orig)(self, sel, arg);
      };
      break;
    case kRunningActivate:
      block = ^BOOL(id self, NSApplicationActivationOptions options) {
        // Only this process's own activation; other apps are none of our business.
        if ([(NSRunningApplication *)self processIdentifier] == getpid() && !allowed(cname, sname))
          return NO;
        return ((BOOL (*)(id, SEL, NSApplicationActivationOptions))orig)(self, sel, options);
      };
      break;
    case kOrderWindow:
      block = ^(id self, NSWindowOrderingMode place, NSInteger other) {
        // Ordering out is always fine.
        if (place == NSWindowOut || allowed(cname, sname))
          ((void (*)(id, SEL, NSWindowOrderingMode, NSInteger))orig)(self, sel, place, other);
      };
      break;
  }
  method_setImplementation(m, imp_implementationWithBlock(block));
}

static BOOL inherits(Class cls, Class base) {
  for (Class c = cls; c; c = class_getSuperclass(c))
    if (c == base)
      return YES;
  return NO;
}

static void hookClass(Class cls) {
  static Class app, window, running;
  if (!app) {
    app = objc_getClass("NSApplication");
    window = objc_getClass("NSWindow");
    running = objc_getClass("NSRunningApplication");
  }
  const Gated *sels = NULL;
  size_t n = 0;
  if (inherits(cls, window)) {
    sels = windowSels;
    n = sizeof(windowSels) / sizeof(*windowSels);
  } else if (inherits(cls, app)) {
    sels = appSels;
    n = sizeof(appSels) / sizeof(*appSels);
  } else if (inherits(cls, running)) {
    sels = runningSels;
    n = sizeof(runningSels) / sizeof(*runningSels);
  }
  for (size_t i = 0; i < n; i++)
    hookOne(cls, &sels[i]);
}

static void onImageAdded(const struct mach_header *header, intptr_t slide) {
  Dl_info info;
  if (!dladdr(header, &info) || !info.dli_fname)
    return;
  unsigned count = 0;
  const char **names = objc_copyClassNamesForImage(info.dli_fname, &count);
  for (unsigned i = 0; i < count; i++) {
    Class cls = objc_getClass(names[i]);
    if (cls)
      hookClass(cls);
  }
  free(names);
}

__attribute__((constructor)) static void installShowGate(void) {
  const char *gate = getenv("AGENTIC_SHOW_GATE");
  const char *log = getenv("AGENTIC_SHOW_GATE_LOG");
  if (!gate || !*gate)
    return;  // Not launched by the gateway: behave like plain Chrome.
  gatePath = strdup(gate);
  logPath = log && *log ? strdup(log) : NULL;
  // Child processes (renderers, GPU) must not inherit these.
  unsetenv("AGENTIC_SHOW_GATE");
  unsetenv("AGENTIC_SHOW_GATE_LOG");
  // Called now for every image already loaded (AppKit included), then for
  // each image loaded later.
  _dyld_register_func_for_add_image(onImageAdded);
}
