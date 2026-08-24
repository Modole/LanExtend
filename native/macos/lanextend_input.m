#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static atomic_bool gActive = false;
static CFMachPortRef gEventTap = NULL;
static CFRunLoopRef gRunLoop = NULL;
static pthread_mutex_t gOutputLock = PTHREAD_MUTEX_INITIALIZER;
static bool gModifierState[256] = { false };

static void WriteLine(NSString *line) {
  pthread_mutex_lock(&gOutputLock);
  fprintf(stdout, "%s\n", line.UTF8String);
  fflush(stdout);
  pthread_mutex_unlock(&gOutputLock);
}

static void WriteObject(NSDictionary *object) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (data == nil) return;
  NSString *line = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (line != nil) WriteLine(line);
}

static void WriteResponse(NSString *requestId, bool ok, NSDictionary *payload, NSString *error) {
  if (requestId.length == 0) return;
  NSMutableDictionary *response = [@{
    @"event": @"response",
    @"requestId": requestId,
    @"ok": @(ok)
  } mutableCopy];
  if (payload != nil) [response addEntriesFromDictionary:payload];
  if (error.length > 0) response[@"error"] = error;
  WriteObject(response);
}

static void WriteReady(bool trusted) {
  WriteLine([NSString stringWithFormat:@"{\"event\":\"ready\",\"trusted\":%@}", trusted ? @"true" : @"false"]);
}

static NSString *MouseButtonName(CGMouseButton button) {
  if (button == kCGMouseButtonLeft) return @"left";
  if (button == kCGMouseButtonRight) return @"right";
  if (button == kCGMouseButtonCenter) return @"middle";
  return @"other";
}

static bool IsMouseMove(CGEventType type) {
  return type == kCGEventMouseMoved
    || type == kCGEventLeftMouseDragged
    || type == kCGEventRightMouseDragged
    || type == kCGEventOtherMouseDragged;
}

static bool IsMouseDown(CGEventType type) {
  return type == kCGEventLeftMouseDown
    || type == kCGEventRightMouseDown
    || type == kCGEventOtherMouseDown;
}

static bool IsMouseUp(CGEventType type) {
  return type == kCGEventLeftMouseUp
    || type == kCGEventRightMouseUp
    || type == kCGEventOtherMouseUp;
}

static CGEventRef EventCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
  (void)proxy;
  (void)context;
  @autoreleasepool {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (gEventTap != NULL) CGEventTapEnable(gEventTap, true);
    return event;
  }

  const bool active = atomic_load(&gActive);
  if (IsMouseMove(type)) {
    CGPoint point = CGEventGetLocation(event);
    int64_t deltaX = CGEventGetIntegerValueField(event, kCGMouseEventDeltaX);
    int64_t deltaY = CGEventGetIntegerValueField(event, kCGMouseEventDeltaY);
    WriteLine([NSString stringWithFormat:
      @"{\"event\":\"move\",\"x\":%.2f,\"y\":%.2f,\"dx\":%lld,\"dy\":%lld}",
      point.x, point.y, deltaX, deltaY]);
    return active ? NULL : event;
  }

  if (!active) return event;

  if (IsMouseDown(type) || IsMouseUp(type)) {
    CGMouseButton button = (CGMouseButton)CGEventGetIntegerValueField(event, kCGMouseEventButtonNumber);
    int64_t clicks = CGEventGetIntegerValueField(event, kCGMouseEventClickState);
    WriteLine([NSString stringWithFormat:
      @"{\"event\":\"button\",\"button\":\"%@\",\"down\":%@,\"clicks\":%lld}",
      MouseButtonName(button), IsMouseDown(type) ? @"true" : @"false", MAX((int64_t)1, clicks)]);
    return NULL;
  }

  if (type == kCGEventScrollWheel) {
    int64_t deltaY = CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis1);
    int64_t deltaX = CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis2);
    WriteLine([NSString stringWithFormat:
      @"{\"event\":\"scroll\",\"deltaX\":%lld,\"deltaY\":%lld}", deltaX, deltaY]);
    return NULL;
  }

  if (type == kCGEventKeyDown || type == kCGEventKeyUp || type == kCGEventFlagsChanged) {
    int64_t keyCode = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    CGEventFlags flags = CGEventGetFlags(event);
    bool down = type == kCGEventKeyDown;
    if (type == kCGEventFlagsChanged && keyCode >= 0 && keyCode < 256) {
      down = !gModifierState[keyCode];
      gModifierState[keyCode] = down;
    } else if (keyCode >= 0 && keyCode < 256) {
      gModifierState[keyCode] = down;
    }
    const CGEventFlags escapeFlags = kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate | kCGEventFlagMaskControl;
    if (keyCode == 53 && down && (flags & escapeFlags) == escapeFlags) {
      atomic_store(&gActive, false);
      memset(gModifierState, 0, sizeof(gModifierState));
      WriteLine(@"{\"event\":\"release\"}");
      return NULL;
    }
    bool repeat = CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) != 0;
    WriteLine([NSString stringWithFormat:
      @"{\"event\":\"key\",\"keyCode\":%lld,\"down\":%@,\"repeat\":%@}",
      keyCode, down ? @"true" : @"false", repeat ? @"true" : @"false"]);
    return NULL;
  }

    return active ? NULL : event;
  }
}

static void HandleCommand(NSDictionary *command) {
  NSString *name = [command[@"command"] isKindOfClass:NSString.class] ? command[@"command"] : @"";
  NSString *requestId = [command[@"requestId"] isKindOfClass:NSString.class] ? command[@"requestId"] : @"";
  if ([name isEqualToString:@"clipboard-read"]) {
    dispatch_async(dispatch_get_main_queue(), ^{
      NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
      NSDictionary *options = @{NSPasteboardURLReadingFileURLsOnlyKey: @YES};
      NSArray<NSURL *> *urls = [pasteboard readObjectsForClasses:@[NSURL.class] options:options] ?: @[];
      NSMutableArray<NSString *> *paths = [NSMutableArray array];
      for (NSURL *url in urls) {
        if (url.isFileURL && url.path.length > 0) [paths addObject:url.path];
      }
      WriteResponse(requestId, true, @{
        @"paths": paths,
        @"revision": @(pasteboard.changeCount)
      }, nil);
    });
    return;
  }
  if ([name isEqualToString:@"clipboard-write"]) {
    NSArray *values = [command[@"paths"] isKindOfClass:NSArray.class] ? command[@"paths"] : @[];
    dispatch_async(dispatch_get_main_queue(), ^{
      NSMutableArray<NSURL *> *urls = [NSMutableArray array];
      for (id value in values) {
        if (![value isKindOfClass:NSString.class] || [value length] == 0) continue;
        NSURL *url = [NSURL fileURLWithPath:value];
        if (url != nil) [urls addObject:url];
      }
      if (urls.count == 0) {
        WriteResponse(requestId, false, nil, @"没有可写入剪贴板的文件");
        return;
      }
      NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
      [pasteboard clearContents];
      bool written = [pasteboard writeObjects:urls];
      WriteResponse(requestId, written, written ? @{
        @"revision": @(pasteboard.changeCount)
      } : nil, written ? nil : @"macOS 文件剪贴板写入失败");
    });
    return;
  }
  if ([name isEqualToString:@"activate"]) {
    atomic_store(&gActive, true);
    return;
  }
  if ([name isEqualToString:@"deactivate"]) {
    atomic_store(&gActive, false);
    memset(gModifierState, 0, sizeof(gModifierState));
    return;
  }
  if ([name isEqualToString:@"warp"]) {
    NSNumber *x = [command[@"x"] isKindOfClass:NSNumber.class] ? command[@"x"] : @0;
    NSNumber *y = [command[@"y"] isKindOfClass:NSNumber.class] ? command[@"y"] : @0;
    CGWarpMouseCursorPosition(CGPointMake(x.doubleValue, y.doubleValue));
    CGAssociateMouseAndMouseCursorPosition(true);
    return;
  }
  if ([name isEqualToString:@"quit"]) {
    atomic_store(&gActive, false);
    if (gRunLoop != NULL) CFRunLoopStop(gRunLoop);
  }
}

static void StartCommandReader(void) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    char *line = NULL;
    size_t capacity = 0;
    while (getline(&line, &capacity, stdin) >= 0) {
      @autoreleasepool {
        NSData *data = [NSData dataWithBytes:line length:strlen(line)];
        NSError *error = nil;
        id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
        if ([object isKindOfClass:NSDictionary.class]) HandleCommand(object);
      }
    }
    free(line);
    if (gRunLoop != NULL) CFRunLoopStop(gRunLoop);
  });
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    bool probe = argc > 1 && strcmp(argv[1], "--probe") == 0;
    bool trusted = false;
    if (probe) {
      // macOS 26 can crash inside AXIsProcessTrustedWithOptions when it receives
      // an empty options dictionary. The plain API is the correct no-prompt probe.
      trusted = AXIsProcessTrusted();
    } else {
      NSDictionary *trustOptions = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES};
      trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)trustOptions);
    }
    if (probe) {
      WriteLine([NSString stringWithFormat:@"{\"event\":\"probe\",\"trusted\":%@}", trusted ? @"true" : @"false"]);
      return trusted ? 0 : 2;
    }
    if (!trusted) {
      WriteReady(false);
      return 2;
    }

    CGEventMask mask = CGEventMaskBit(kCGEventMouseMoved)
      | CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp)
      | CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventRightMouseUp)
      | CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp)
      | CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseDragged)
      | CGEventMaskBit(kCGEventOtherMouseDragged) | CGEventMaskBit(kCGEventScrollWheel)
      | CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp)
      | CGEventMaskBit(kCGEventFlagsChanged);
    gEventTap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
      mask, EventCallback, NULL);
    if (gEventTap == NULL) {
      WriteReady(false);
      return 3;
    }
    CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, gEventTap, 0);
    gRunLoop = CFRunLoopGetCurrent();
    CFRetain(gRunLoop);
    CFRunLoopAddSource(gRunLoop, source, kCFRunLoopCommonModes);
    CGEventTapEnable(gEventTap, true);
    StartCommandReader();
    WriteReady(true);
    CFRunLoopRun();

    CFRunLoopRemoveSource(gRunLoop, source, kCFRunLoopCommonModes);
    CFRelease(source);
    CFRelease(gEventTap);
    CFRelease(gRunLoop);
    gEventTap = NULL;
    gRunLoop = NULL;
    return 0;
  }
}
