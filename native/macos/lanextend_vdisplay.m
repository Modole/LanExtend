// Copyright (c) 2026 LanExtend contributors
// SPDX-License-Identifier: MIT

#import "CGVirtualDisplayPrivate.h"
#import <AppKit/AppKit.h>

#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <math.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t gShouldStop = 0;
static volatile sig_atomic_t gDisplayTerminated = 0;
static CGVirtualDisplay *__strong gDisplay = nil;
static CGVirtualDisplayDescriptor *__strong gDescriptor = nil;

typedef struct {
  uint32_t width;
  uint32_t height;
  uint32_t serial;
  double fps;
  BOOL hiDPI;
} DisplayOptions;

static void HandleSignal(int signalNumber) {
  (void)signalNumber;
  gShouldStop = 1;
}

static void InstallSignalHandlers(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = HandleSignal;
  sigemptyset(&action.sa_mask);
  (void)sigaction(SIGTERM, &action, NULL);
  (void)sigaction(SIGINT, &action, NULL);
  (void)sigaction(SIGHUP, &action, NULL);
}

static void EmitJSONToStream(NSDictionary<NSString *, id> *object,
                             FILE *stream) {
  NSError *error = nil;
  NSData *data =
      [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (data == nil) {
    fprintf(stderr, "lanextend-vdisplay: JSON serialization failed: %s\n",
            error.localizedDescription.UTF8String ?: "unknown error");
    return;
  }

  (void)fwrite(data.bytes, 1, data.length, stream);
  (void)fputc('\n', stream);
  (void)fflush(stream);
}

static void EmitJSON(NSDictionary<NSString *, id> *object) {
  EmitJSONToStream(object, stdout);
}

static void EmitError(NSString *code, NSString *message) {
  EmitJSON(@{
    @"event" : @"error",
    @"code" : code,
    @"message" : message,
  });
}

static BOOL ClassImplements(Class candidate, SEL selector) {
  return candidate != Nil && [candidate instancesRespondToSelector:selector];
}

static NSDictionary<NSString *, id> *ProbeResult(void) {
  Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
  Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
  Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
  Class displayClass = NSClassFromString(@"CGVirtualDisplay");
  NSMutableArray<NSString *> *missing = [NSMutableArray array];

  if (descriptorClass == Nil) {
    [missing addObject:@"CGVirtualDisplayDescriptor"];
  }
  if (modeClass == Nil) {
    [missing addObject:@"CGVirtualDisplayMode"];
  }
  if (settingsClass == Nil) {
    [missing addObject:@"CGVirtualDisplaySettings"];
  }
  if (displayClass == Nil) {
    [missing addObject:@"CGVirtualDisplay"];
  }

  NSArray<NSString *> *descriptorSelectors = @[
    @"setName:",
    @"setVendorID:",
    @"setProductID:",
    @"setSerialNum:",
    @"setMaxPixelsWide:",
    @"setMaxPixelsHigh:",
    @"setSizeInMillimeters:",
    @"setWhitePoint:",
    @"setRedPrimary:",
    @"setGreenPrimary:",
    @"setBluePrimary:",
  ];
  for (NSString *selectorName in descriptorSelectors) {
    if (!ClassImplements(descriptorClass,
                         NSSelectorFromString(selectorName))) {
      [missing addObject:[@"CGVirtualDisplayDescriptor."
                             stringByAppendingString:selectorName]];
    }
  }

  BOOL hasQueueSetter =
      ClassImplements(descriptorClass, NSSelectorFromString(@"setQueue:")) ||
      ClassImplements(descriptorClass,
                      NSSelectorFromString(@"setDispatchQueue:"));
  if (!hasQueueSetter) {
    [missing addObject:@"CGVirtualDisplayDescriptor.queue setter"];
  }

  if (!ClassImplements(
          modeClass,
          NSSelectorFromString(@"initWithWidth:height:refreshRate:"))) {
    [missing addObject:@"CGVirtualDisplayMode.init"];
  }
  if (!ClassImplements(settingsClass, NSSelectorFromString(@"setHiDPI:"))) {
    [missing addObject:@"CGVirtualDisplaySettings.setHiDPI:"];
  }
  if (!ClassImplements(settingsClass, NSSelectorFromString(@"setModes:"))) {
    [missing addObject:@"CGVirtualDisplaySettings.setModes:"];
  }
  if (!ClassImplements(displayClass,
                       NSSelectorFromString(@"initWithDescriptor:"))) {
    [missing addObject:@"CGVirtualDisplay.initWithDescriptor:"];
  }
  if (!ClassImplements(displayClass,
                       NSSelectorFromString(@"applySettings:"))) {
    [missing addObject:@"CGVirtualDisplay.applySettings:"];
  }
  if (!ClassImplements(displayClass, NSSelectorFromString(@"displayID"))) {
    [missing addObject:@"CGVirtualDisplay.displayID"];
  }

  BOOL available = missing.count == 0;
  return @{
    @"event" : @"probe",
    @"available" : @(available),
    @"api" : @"CGVirtualDisplay",
    @"privateApi" : @(YES),
    @"osVersion" : NSProcessInfo.processInfo.operatingSystemVersionString,
    @"missing" : missing,
  };
}

static BOOL ParseUInt32(const char *text, uint32_t *result) {
  if (text == NULL || text[0] == '\0' || text[0] == '-') {
    return NO;
  }

  errno = 0;
  char *end = NULL;
  unsigned long parsed = strtoul(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || parsed > UINT32_MAX) {
    return NO;
  }
  *result = (uint32_t)parsed;
  return YES;
}

static BOOL ParseFPS(const char *text, double *result) {
  if (text == NULL || text[0] == '\0') {
    return NO;
  }

  errno = 0;
  char *end = NULL;
  double parsed = strtod(text, &end);
  if (errno != 0 || end == text || *end != '\0' || !isfinite(parsed)) {
    return NO;
  }
  *result = parsed;
  return YES;
}

static BOOL ParseBoolean(const char *text, BOOL *result) {
  if (text == NULL) {
    return NO;
  }
  if (strcasecmp(text, "true") == 0 || strcmp(text, "1") == 0 ||
      strcasecmp(text, "yes") == 0 || strcasecmp(text, "on") == 0) {
    *result = YES;
    return YES;
  }
  if (strcasecmp(text, "false") == 0 || strcmp(text, "0") == 0 ||
      strcasecmp(text, "no") == 0 || strcasecmp(text, "off") == 0) {
    *result = NO;
    return YES;
  }
  return NO;
}

static void PrintUsage(FILE *stream) {
  fprintf(stream,
          "Usage:\n"
          "  lanextend-vdisplay --probe\n"
          "  lanextend-vdisplay create [--width N] [--height N] [--fps N] "
          "[--name TEXT] [--serial N] [--hidpi [true|false]]\n");
}

static BOOL ParseCreateArguments(int argc, const char *argv[],
                                 DisplayOptions *options, NSString **name,
                                 NSString **errorMessage) {
  *options = (DisplayOptions){
      .width = 1920,
      .height = 1080,
      .serial = 1,
      .fps = 60.0,
      .hiDPI = NO,
  };
  *name = @"LanExtend Virtual Display";

  for (int index = 2; index < argc; index++) {
    const char *argument = argv[index];
    if (strcmp(argument, "--width") == 0 ||
        strcmp(argument, "--height") == 0 ||
        strcmp(argument, "--fps") == 0 ||
        strcmp(argument, "--serial") == 0 ||
        strcmp(argument, "--name") == 0) {
      if (index + 1 >= argc) {
        *errorMessage = [NSString
            stringWithFormat:@"Option %s requires a value", argument];
        return NO;
      }
      const char *value = argv[++index];
      if (strcmp(argument, "--width") == 0) {
        if (!ParseUInt32(value, &options->width)) {
          *errorMessage = @"--width must be an integer";
          return NO;
        }
      } else if (strcmp(argument, "--height") == 0) {
        if (!ParseUInt32(value, &options->height)) {
          *errorMessage = @"--height must be an integer";
          return NO;
        }
      } else if (strcmp(argument, "--fps") == 0) {
        if (!ParseFPS(value, &options->fps)) {
          *errorMessage = @"--fps must be a finite number";
          return NO;
        }
      } else if (strcmp(argument, "--serial") == 0) {
        if (!ParseUInt32(value, &options->serial)) {
          *errorMessage = @"--serial must be an integer";
          return NO;
        }
      } else {
        NSString *parsedName = [NSString stringWithUTF8String:value];
        if (parsedName == nil) {
          *errorMessage = @"--name must be valid UTF-8";
          return NO;
        }
        *name = parsedName;
      }
      continue;
    }

    if (strcmp(argument, "--hidpi") == 0 ||
        strcmp(argument, "--hi-dpi") == 0) {
      options->hiDPI = YES;
      if (index + 1 < argc && strncmp(argv[index + 1], "--", 2) != 0) {
        if (!ParseBoolean(argv[++index], &options->hiDPI)) {
          *errorMessage = @"--hidpi expects true or false";
          return NO;
        }
      }
      continue;
    }

    if (strcmp(argument, "--no-hidpi") == 0) {
      options->hiDPI = NO;
      continue;
    }

    *errorMessage =
        [NSString stringWithFormat:@"Unknown option: %s", argument];
    return NO;
  }

  if (options->width < 320 || options->width > 7680 ||
      options->height < 200 || options->height > 7680) {
    *errorMessage = @"width and height must be between 320x200 and 7680x7680";
    return NO;
  }
  if (options->fps < 1.0 || options->fps > 240.0) {
    *errorMessage = @"fps must be between 1 and 240";
    return NO;
  }
  if (options->serial == 0) {
    *errorMessage = @"serial must be between 1 and 4294967295";
    return NO;
  }
  if ((*name).length == 0 || (*name).length > 128) {
    *errorMessage = @"name must contain 1 to 128 characters";
    return NO;
  }
  uint64_t pixelWidth =
      (uint64_t)options->width * (options->hiDPI ? 2U : 1U);
  uint64_t pixelHeight =
      (uint64_t)options->height * (options->hiDPI ? 2U : 1U);
  if (pixelWidth > UINT32_MAX || pixelHeight > UINT32_MAX ||
      pixelWidth > 7680 || pixelHeight > 7680) {
    *errorMessage =
        @"physical pixel dimensions must not exceed 7680x7680";
    return NO;
  }

  return YES;
}

static CGSize PhysicalSizeForResolution(uint32_t width, uint32_t height,
                                        BOOL hiDPI) {
  // Describe a conventional-density panel for 1x modes and a Retina-density
  // panel for 2x modes. WindowServer validates the relationship between pixels
  // and millimetres, so keeping the reported PPI plausible is important.
  const double pixelsPerInch = hiDPI ? 220.0 : 125.0;
  return CGSizeMake(25.4 * (double)width / pixelsPerInch,
                    25.4 * (double)height / pixelsPerInch);
}

static BOOL WaitUntilOnline(CGDirectDisplayID displayID) {
  const useconds_t intervalMicroseconds = 50 * 1000;
  const int attempts = 40;
  for (int attempt = 0; attempt < attempts; attempt++) {
    if (CGDisplayIsOnline(displayID)) {
      return YES;
    }
    (void)usleep(intervalMicroseconds);
  }
  return CGDisplayIsOnline(displayID);
}

static BOOL EnsureExtendedMode(CGDirectDisplayID displayID) {
  if (!CGDisplayIsInMirrorSet(displayID)) {
    return YES;
  }

  CGDisplayConfigRef configuration = NULL;
  CGError error = CGBeginDisplayConfiguration(&configuration);
  if (error == kCGErrorSuccess && configuration != NULL) {
    error = CGConfigureDisplayMirrorOfDisplay(
        configuration, displayID, kCGNullDirectDisplay);
  }
  if (error == kCGErrorSuccess && configuration != NULL) {
    error = CGCompleteDisplayConfiguration(configuration,
                                           kCGConfigureForSession);
    configuration = NULL;
  }
  if (configuration != NULL) {
    CGCancelDisplayConfiguration(configuration);
  }

  if (error != kCGErrorSuccess) {
    EmitJSONToStream(@{
      @"event" : @"warning",
      @"code" : @"unmirror_failed",
      @"message" : @"The virtual display is online but could not be switched "
                    "from mirror mode to extended mode",
      @"displayId" : @(displayID),
      @"cgError" : @(error),
    }, stderr);
    return NO;
  }

  for (int attempt = 0; attempt < 20; attempt++) {
    if (!CGDisplayIsInMirrorSet(displayID)) {
      return YES;
    }
    (void)usleep(50 * 1000);
  }

  EmitJSONToStream(@{
    @"event" : @"warning",
    @"code" : @"still_mirrored",
    @"message" : @"Quartz accepted the unmirror request, but the virtual "
                  "display still reports mirror mode",
    @"displayId" : @(displayID),
  }, stderr);
  return NO;
}

static int CreateDisplay(DisplayOptions options, NSString *name) {
  NSDictionary<NSString *, id> *probe = ProbeResult();
  if (![probe[@"available"] boolValue]) {
    EmitError(@"api_unavailable",
              @"This macOS version does not expose the required "
               "CGVirtualDisplay API");
    return 3;
  }

  Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
  Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
  Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
  Class displayClass = NSClassFromString(@"CGVirtualDisplay");

  // Establish a WindowServer application connection without showing a Dock
  // icon. A standalone Foundation-only command can otherwise be rejected when
  // CGVirtualDisplay tries to register its descriptor.
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];

  CGVirtualDisplayDescriptor *descriptor = [[descriptorClass alloc] init];
  descriptor.name = name;
  descriptor.vendorID = 505;
  descriptor.productID = 0;
  descriptor.serialNum = options.serial;
  if ([descriptor respondsToSelector:@selector(setSerialNumber:)]) {
    descriptor.serialNumber = options.serial;
  }
  uint32_t pixelWidth = options.width * (options.hiDPI ? 2U : 1U);
  uint32_t pixelHeight = options.height * (options.hiDPI ? 2U : 1U);
  descriptor.maxPixelsWide = pixelWidth;
  descriptor.maxPixelsHigh = pixelHeight;
  descriptor.sizeInMillimeters =
      PhysicalSizeForResolution(pixelWidth, pixelHeight, options.hiDPI);
  descriptor.whitePoint = CGPointMake(0.3125, 0.3291);
  descriptor.redPrimary = CGPointMake(0.6797, 0.3203);
  descriptor.greenPrimary = CGPointMake(0.2559, 0.6983);
  descriptor.bluePrimary = CGPointMake(0.1494, 0.0557);

  dispatch_queue_t queue =
      dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
  if ([descriptor respondsToSelector:@selector(setQueue:)]) {
    [descriptor setQueue:queue];
  } else {
    [descriptor setDispatchQueue:queue];
  }

  if ([descriptor respondsToSelector:@selector(setTerminationHandler:)]) {
    descriptor.terminationHandler = ^(id ignoredDisplay, id ignoredError) {
      (void)ignoredDisplay;
      (void)ignoredError;
      gDisplayTerminated = 1;
      gShouldStop = 1;
    };
  }

  CGVirtualDisplayMode *mode = [[modeClass alloc]
      initWithWidth:options.width
             height:options.height
        refreshRate:options.fps];
  if (mode == nil) {
    EmitError(@"mode_creation_failed",
              @"CGVirtualDisplayMode rejected the requested mode");
    return 4;
  }

  CGVirtualDisplaySettings *settings = [[settingsClass alloc] init];
  settings.hiDPI = options.hiDPI ? 1U : 0U;
  if ([settings respondsToSelector:@selector(setRotation:)]) {
    settings.rotation = 0;
  }
  settings.modes = @[ mode ];

  CGVirtualDisplay *display =
      [[displayClass alloc] initWithDescriptor:descriptor];
  if (display == nil) {
    EmitError(@"display_creation_failed",
              @"CGVirtualDisplay rejected the display descriptor");
    return 5;
  }
  if (![display applySettings:settings]) {
    EmitError(@"settings_rejected",
              @"CGVirtualDisplay rejected the requested display settings");
    return 6;
  }

  CGDirectDisplayID displayID = display.displayID;
  if (displayID == kCGNullDirectDisplay) {
    EmitError(@"invalid_display_id",
              @"CGVirtualDisplay returned an invalid display identifier");
    return 7;
  }

  gDescriptor = descriptor;
  gDisplay = display;
  BOOL online = WaitUntilOnline(displayID);
  if (!online) {
    gDisplay = nil;
    gDescriptor = nil;
    EmitError(@"display_not_online",
              @"The virtual display did not become online within two seconds");
    return 8;
  }

  BOOL extended = EnsureExtendedMode(displayID);

  InstallSignalHandlers();
  EmitJSON(@{
    @"event" : @"ready",
    @"displayId" : @(displayID),
    @"width" : @(options.width),
    @"height" : @(options.height),
    @"logicalWidth" : @(options.width),
    @"logicalHeight" : @(options.height),
    @"pixelWidth" : @(pixelWidth),
    @"pixelHeight" : @(pixelHeight),
    @"fps" : @(options.fps),
    @"name" : name,
    @"serial" : @(options.serial),
    @"hiDPI" : @(options.hiDPI),
    @"extended" : @(extended),
    @"pid" : @((int)getpid()),
  });

  while (!gShouldStop) {
    @autoreleasepool {
      (void)CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.25, false);
    }
  }

  NSString *reason = gDisplayTerminated ? @"system" : @"signal";
  gDisplay = nil;
  gDescriptor = nil;
  EmitJSON(@{
    @"event" : @"stopped",
    @"displayId" : @(displayID),
    @"reason" : reason,
  });
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
      NSDictionary<NSString *, id> *probe = ProbeResult();
      EmitJSON(probe);
      return [probe[@"available"] boolValue] ? 0 : 2;
    }

    if (argc == 2 &&
        (strcmp(argv[1], "--help") == 0 || strcmp(argv[1], "-h") == 0)) {
      PrintUsage(stdout);
      return 0;
    }

    if (argc < 2 || strcmp(argv[1], "create") != 0) {
      EmitError(@"usage", @"Expected --probe or the create command");
      PrintUsage(stderr);
      return 64;
    }

    DisplayOptions options;
    NSString *name = nil;
    NSString *argumentError = nil;
    if (!ParseCreateArguments(argc, argv, &options, &name, &argumentError)) {
      EmitError(@"invalid_argument", argumentError ?: @"Invalid argument");
      PrintUsage(stderr);
      return 64;
    }

    return CreateDisplay(options, name);
  }
}
