#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <unistd.h>

@interface MLStep : NSObject
@property CGFloat x;
@property CGFloat y;
@property NSInteger delay;
+ (instancetype)stepWithX:(CGFloat)x y:(CGFloat)y delay:(NSInteger)delay;
- (NSDictionary *)dictionary;
@end

@implementation MLStep
+ (instancetype)stepWithX:(CGFloat)x y:(CGFloat)y delay:(NSInteger)delay {
    MLStep *step = [MLStep new];
    step.x = x;
    step.y = y;
    step.delay = delay;
    return step;
}
- (NSDictionary *)dictionary {
    return @{ @"x": @(self.x), @"y": @(self.y), @"delay": @(self.delay) };
}
@end

@interface AppDelegate : NSObject <NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate>
@property NSWindow *window;
@property NSTableView *table;
@property NSMutableArray<MLStep *> *steps;
@property NSTextField *repeatField;
@property NSTextField *statusLabel;
@property NSButton *recordButton;
@property NSButton *startButton;
@property NSButton *stopButton;
@property id eventMonitor;
@property BOOL recording;
@property BOOL running;
@property NSDate *lastClickDate;
@property NSTimer *playTimer;
@property NSInteger playIndex;
@property NSInteger completedLoops;
@property id activityToken;
@property BOOL permissionPromptRequested;
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    self.steps = [NSMutableArray array];
    [self loadConfig];
    [self buildUI];
    [self installGlobalMonitor];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    if (self.eventMonitor) [NSEvent removeMonitor:self.eventMonitor];
    [self.playTimer invalidate];
    if (self.activityToken) [[NSProcessInfo processInfo] endActivity:self.activityToken];
}

- (NSTextField *)label:(NSString *)text frame:(NSRect)frame size:(CGFloat)size weight:(NSFontWeight)weight {
    NSTextField *label = [[NSTextField alloc] initWithFrame:frame];
    label.stringValue = text;
    label.editable = NO;
    label.bezeled = NO;
    label.drawsBackground = NO;
    label.font = [NSFont systemFontOfSize:size weight:weight];
    return label;
}

- (NSButton *)button:(NSString *)title frame:(NSRect)frame action:(SEL)action {
    NSButton *button = [[NSButton alloc] initWithFrame:frame];
    button.title = title;
    button.bezelStyle = NSBezelStyleRounded;
    button.target = self;
    button.action = action;
    return button;
}

- (void)buildUI {
    NSRect frame = NSMakeRect(0, 0, 720, 590);
    self.window = [[NSWindow alloc] initWithContentRect:frame
                                             styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable)
                                               backing:NSBackingStoreBuffered
                                                 defer:NO];
    self.window.title = @"Mouse Loop · 桌面连点器";
    self.window.minSize = NSMakeSize(720, 590);
    [self.window center];
    NSView *content = self.window.contentView;

    NSTextField *eyebrow = [self label:@"MOUSE LOOP FOR macOS" frame:NSMakeRect(28, 544, 300, 18) size:11 weight:NSFontWeightBold];
    eyebrow.textColor = [NSColor colorWithRed:0.89 green:0.27 blue:0.13 alpha:1];
    [content addSubview:eyebrow];
    [content addSubview:[self label:@"桌面坐标连点器" frame:NSMakeRect(26, 505, 330, 38) size:27 weight:NSFontWeightBold]];

    self.statusLabel = [self label:@"已停止" frame:NSMakeRect(420, 517, 270, 24) size:13 weight:NSFontWeightSemibold];
    self.statusLabel.alignment = NSTextAlignmentRight;
    self.statusLabel.textColor = NSColor.secondaryLabelColor;
    [content addSubview:self.statusLabel];

    [content addSubview:[self label:@"循环次数" frame:NSMakeRect(28, 465, 90, 22) size:13 weight:NSFontWeightSemibold]];
    self.repeatField = [[NSTextField alloc] initWithFrame:NSMakeRect(116, 459, 84, 30)];
    self.repeatField.integerValue = MAX(0, [[NSUserDefaults standardUserDefaults] integerForKey:@"repeatCount"]);
    self.repeatField.alignment = NSTextAlignmentCenter;
    self.repeatField.placeholderString = @"0";
    [content addSubview:self.repeatField];
    NSTextField *hint = [self label:@"0 = 无限循环" frame:NSMakeRect(210, 465, 110, 20) size:11 weight:NSFontWeightRegular];
    hint.textColor = NSColor.secondaryLabelColor;
    [content addSubview:hint];

    self.recordButton = [self button:@"● 录制一轮" frame:NSMakeRect(456, 454, 120, 38) action:@selector(startRecording:)];
    [content addSubview:self.recordButton];
    [content addSubview:[self button:@"＋ 添加" frame:NSMakeRect(584, 454, 106, 38) action:@selector(addStep:)]];

    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(28, 148, 662, 290)];
    scroll.hasVerticalScroller = YES;
    scroll.borderType = NSBezelBorder;
    self.table = [[NSTableView alloc] initWithFrame:scroll.bounds];
    self.table.dataSource = self;
    self.table.delegate = self;
    self.table.rowHeight = 34;
    self.table.usesAlternatingRowBackgroundColors = YES;
    self.table.allowsMultipleSelection = YES;
    NSArray *columns = @[
        @{ @"id": @"index", @"title": @"步骤", @"width": @70 },
        @{ @"id": @"x", @"title": @"X 坐标", @"width": @140 },
        @{ @"id": @"y", @"title": @"Y 坐标", @"width": @140 },
        @{ @"id": @"delay", @"title": @"下一步间隔（ms）", @"width": @250 }
    ];
    for (NSDictionary *item in columns) {
        NSTableColumn *column = [[NSTableColumn alloc] initWithIdentifier:item[@"id"]];
        column.title = item[@"title"];
        column.width = [item[@"width"] doubleValue];
        [self.table addTableColumn:column];
    }
    scroll.documentView = self.table;
    [content addSubview:scroll];

    [content addSubview:[self button:@"删除选中" frame:NSMakeRect(28, 101, 110, 34) action:@selector(deleteSelected:)]];
    NSTextField *shortcuts = [self label:@"录制完成：⌘⇧R    紧急停止：⌘⇧S" frame:NSMakeRect(155, 107, 360, 20) size:12 weight:NSFontWeightMedium];
    shortcuts.textColor = NSColor.secondaryLabelColor;
    [content addSubview:shortcuts];

    self.stopButton = [self button:@"停止" frame:NSMakeRect(28, 35, 130, 46) action:@selector(stopAction:)];
    self.stopButton.enabled = NO;
    [content addSubview:self.stopButton];
    self.startButton = [self button:@"隐藏窗口并开始" frame:NSMakeRect(174, 35, 516, 46) action:@selector(startPlayback:)];
    self.startButton.keyEquivalent = @"\r";
    [content addSubview:self.startButton];

    NSTextField *footer = [self label:@"目标窗口必须可见。锁屏、睡眠或目标窗口最小化时无法按坐标点击。" frame:NSMakeRect(28, 8, 662, 18) size:10 weight:NSFontWeightRegular];
    footer.textColor = NSColor.tertiaryLabelColor;
    [content addSubview:footer];
}

- (NSInteger)numberOfRowsInTableView:(NSTableView *)tableView {
    return self.steps.count;
}

- (NSView *)tableView:(NSTableView *)tableView viewForTableColumn:(NSTableColumn *)tableColumn row:(NSInteger)row {
    NSString *identifier = tableColumn.identifier;
    NSTableCellView *cell = [tableView makeViewWithIdentifier:identifier owner:self];
    if (!cell) {
        cell = [[NSTableCellView alloc] initWithFrame:NSMakeRect(0, 0, tableColumn.width, 34)];
        cell.identifier = identifier;
        NSTextField *field = [[NSTextField alloc] initWithFrame:NSMakeRect(6, 4, tableColumn.width - 12, 26)];
        field.identifier = @"field";
        field.alignment = NSTextAlignmentCenter;
        field.delegate = self;
        [cell addSubview:field];
        cell.textField = field;
    }
    MLStep *step = self.steps[row];
    NSTextField *field = cell.textField;
    NSInteger code = 0;
    if ([identifier isEqualToString:@"index"]) {
        field.stringValue = [NSString stringWithFormat:@"%02ld", (long)row + 1];
        field.editable = NO;
        field.bezeled = NO;
        field.drawsBackground = NO;
        field.textColor = [NSColor colorWithRed:0.89 green:0.27 blue:0.13 alpha:1];
    } else {
        field.editable = YES;
        field.bezeled = YES;
        field.drawsBackground = YES;
        field.textColor = NSColor.labelColor;
        if ([identifier isEqualToString:@"x"]) { field.stringValue = [NSString stringWithFormat:@"%.0f", step.x]; code = 1; }
        if ([identifier isEqualToString:@"y"]) { field.stringValue = [NSString stringWithFormat:@"%.0f", step.y]; code = 2; }
        if ([identifier isEqualToString:@"delay"]) { field.stringValue = [NSString stringWithFormat:@"%ld", (long)step.delay]; code = 3; }
    }
    field.tag = row * 10 + code;
    return cell;
}

- (void)controlTextDidEndEditing:(NSNotification *)notification {
    NSTextField *field = notification.object;
    NSInteger row = field.tag / 10;
    NSInteger code = field.tag % 10;
    if (row < 0 || row >= self.steps.count) return;
    MLStep *step = self.steps[row];
    if (code == 1) step.x = field.doubleValue;
    if (code == 2) step.y = field.doubleValue;
    if (code == 3) step.delay = MAX(0, field.integerValue);
    [self saveConfig];
}

- (BOOL)ensureAccessibility {
    BOOL trusted = AXIsProcessTrusted();
    if (!trusted) {
        self.statusLabel.stringValue = @"授权后请完全退出并重新打开 Mouse Loop";
        if (!self.permissionPromptRequested) {
            self.permissionPromptRequested = YES;
            NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
            AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
        }
    }
    return trusted;
}

- (void)installGlobalMonitor {
    if (self.eventMonitor) {
        [NSEvent removeMonitor:self.eventMonitor];
        self.eventMonitor = nil;
    }
    __weak typeof(self) weakSelf = self;
    self.eventMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:(NSEventMaskLeftMouseDown | NSEventMaskKeyDown)
                                                               handler:^(NSEvent *event) {
        AppDelegate *selfRef = weakSelf;
        if (!selfRef) return;
        if (event.type == NSEventTypeKeyDown) {
            NSEventModifierFlags flags = event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
            BOOL combo = (flags & NSEventModifierFlagCommand) && (flags & NSEventModifierFlagShift);
            NSString *key = event.charactersIgnoringModifiers.lowercaseString;
            if (combo && [key isEqualToString:@"r"] && selfRef.recording) {
                dispatch_async(dispatch_get_main_queue(), ^{ [selfRef finishRecording]; });
            }
            if (combo && [key isEqualToString:@"s"] && selfRef.running) {
                dispatch_async(dispatch_get_main_queue(), ^{ [selfRef stopPlayback:nil]; });
            }
            return;
        }
        if (event.type == NSEventTypeLeftMouseDown && selfRef.recording) {
            CGPoint point = CGEventGetLocation(event.CGEvent);
            NSDate *now = [NSDate date];
            dispatch_async(dispatch_get_main_queue(), ^{ [selfRef recordPoint:point at:now]; });
        }
    }];
}

- (void)startRecording:(id)sender {
    if (![self ensureAccessibility]) return;
    [self installGlobalMonitor];
    [self stopPlayback:nil];
    [self.steps removeAllObjects];
    self.recording = YES;
    self.lastClickDate = nil;
    self.statusLabel.stringValue = @"录制中…完成后按 ⌘⇧R";
    self.recordButton.enabled = NO;
    self.startButton.enabled = NO;
    self.stopButton.enabled = YES;
    self.stopButton.title = @"完成录制";
    [self.table reloadData];
    [NSApp hide:nil];
}

- (void)recordPoint:(CGPoint)point at:(NSDate *)date {
    if (!self.recording) return;
    MLStep *previous = self.steps.lastObject;
    if (previous && self.lastClickDate) {
        previous.delay = MAX(0, (NSInteger)llround([date timeIntervalSinceDate:self.lastClickDate] * 1000.0));
    }
    [self.steps addObject:[MLStep stepWithX:point.x y:point.y delay:1000]];
    self.lastClickDate = date;
    self.statusLabel.stringValue = [NSString stringWithFormat:@"录制中：已记录 %ld 步", (long)self.steps.count];
    [self.table reloadData];
}

- (void)finishRecording {
    if (!self.recording) return;
    self.recording = NO;
    if (self.steps.lastObject && self.lastClickDate) {
        self.steps.lastObject.delay = MAX(0, (NSInteger)llround(-[self.lastClickDate timeIntervalSinceNow] * 1000.0));
    }
    self.recordButton.enabled = YES;
    self.startButton.enabled = YES;
    self.stopButton.enabled = NO;
    self.stopButton.title = @"停止";
    self.statusLabel.stringValue = self.steps.count
        ? [NSString stringWithFormat:@"录制完成：%ld 步", (long)self.steps.count]
        : @"未记录任何点击";
    [self.table reloadData];
    [self saveConfig];
    [NSApp unhide:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [self.window makeKeyAndOrderFront:nil];
}

- (void)addStep:(id)sender {
    [self.steps addObject:[MLStep stepWithX:500 y:400 delay:1000]];
    [self.table reloadData];
    [self saveConfig];
}

- (void)deleteSelected:(id)sender {
    NSIndexSet *selected = self.table.selectedRowIndexes;
    if (!selected.count) return;
    [self.steps removeObjectsAtIndexes:selected];
    [self.table reloadData];
    [self saveConfig];
}

- (void)startPlayback:(id)sender {
    [self.window makeFirstResponder:nil];
    if (![self ensureAccessibility]) return;
    [self installGlobalMonitor];
    if (!self.steps.count) {
        self.statusLabel.stringValue = @"请先录制或添加步骤";
        return;
    }
    [self saveConfig];
    self.running = YES;
    self.playIndex = 0;
    self.completedLoops = 0;
    self.startButton.enabled = NO;
    self.recordButton.enabled = NO;
    self.stopButton.enabled = YES;
    self.stopButton.title = @"停止";
    self.statusLabel.stringValue = @"运行中…⌘⇧S 可紧急停止";
    self.activityToken = [[NSProcessInfo processInfo] beginActivityWithOptions:(NSActivityUserInitiated | NSActivityLatencyCritical)
                                                                        reason:@"Running mouse macro"];
    [NSApp hide:nil];
    self.playTimer = [NSTimer scheduledTimerWithTimeInterval:0.45 target:self selector:@selector(playNextStep:) userInfo:nil repeats:NO];
}

- (void)playNextStep:(NSTimer *)timer {
    if (!self.running || !self.steps.count) return;
    MLStep *step = self.steps[self.playIndex];
    CGPoint point = CGPointMake(step.x, step.y);
    CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, point, kCGMouseButtonLeft);
    CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
    CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
    if (move) { CGEventPost(kCGHIDEventTap, move); CFRelease(move); }
    if (down) { CGEventPost(kCGHIDEventTap, down); CFRelease(down); }
    usleep(20000);
    if (up) { CGEventPost(kCGHIDEventTap, up); CFRelease(up); }

    self.playIndex += 1;
    if (self.playIndex >= self.steps.count) {
        self.playIndex = 0;
        self.completedLoops += 1;
        NSInteger requestedLoops = MAX(0, self.repeatField.integerValue);
        if (requestedLoops > 0 && self.completedLoops >= requestedLoops) {
            [self stopPlayback:nil];
            self.statusLabel.stringValue = [NSString stringWithFormat:@"已完成 %ld 轮", (long)self.completedLoops];
            return;
        }
    }
    self.playTimer = [NSTimer scheduledTimerWithTimeInterval:(MAX(0, step.delay) / 1000.0)
                                                      target:self
                                                    selector:@selector(playNextStep:)
                                                    userInfo:nil
                                                     repeats:NO];
}

- (void)stopPlayback:(id)sender {
    BOOL wasActive = self.running;
    self.running = NO;
    [self.playTimer invalidate];
    self.playTimer = nil;
    if (self.activityToken) {
        [[NSProcessInfo processInfo] endActivity:self.activityToken];
        self.activityToken = nil;
    }
    if (self.window) {
        self.startButton.enabled = YES;
        self.recordButton.enabled = YES;
        self.stopButton.enabled = NO;
        self.stopButton.title = @"停止";
    }
    if (wasActive) self.statusLabel.stringValue = @"已停止";
    [NSApp unhide:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [self.window makeKeyAndOrderFront:nil];
}

- (void)stopAction:(id)sender {
    if (self.recording) {
        [self finishRecording];
        return;
    }
    [self stopPlayback:sender];
}

- (NSString *)configPath {
    NSURL *support = [[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];
    NSURL *directory = [support URLByAppendingPathComponent:@"MouseLoop" isDirectory:YES];
    [[NSFileManager defaultManager] createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:nil];
    return [[directory URLByAppendingPathComponent:@"steps.json"] path];
}

- (void)saveConfig {
    NSMutableArray *items = [NSMutableArray array];
    for (MLStep *step in self.steps) [items addObject:step.dictionary];
    NSDictionary *config = @{ @"steps": items, @"repeatCount": @(MAX(0, self.repeatField.integerValue)) };
    NSData *data = [NSJSONSerialization dataWithJSONObject:config options:NSJSONWritingPrettyPrinted error:nil];
    [data writeToFile:self.configPath options:NSDataWritingAtomic error:nil];
    [[NSUserDefaults standardUserDefaults] setInteger:MAX(0, self.repeatField.integerValue) forKey:@"repeatCount"];
}

- (void)loadConfig {
    NSData *data = [NSData dataWithContentsOfFile:self.configPath];
    if (!data) return;
    NSDictionary *config = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    for (NSDictionary *item in config[@"steps"]) {
        [self.steps addObject:[MLStep stepWithX:[item[@"x"] doubleValue]
                                             y:[item[@"y"] doubleValue]
                                         delay:MAX(0, [item[@"delay"] integerValue])]];
    }
    if (config[@"repeatCount"]) [[NSUserDefaults standardUserDefaults] setInteger:[config[@"repeatCount"] integerValue] forKey:@"repeatCount"];
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *app = [NSApplication sharedApplication];
        app.activationPolicy = NSApplicationActivationPolicyRegular;
        AppDelegate *delegate = [AppDelegate new];
        app.delegate = delegate;
        [app run];
    }
    return 0;
}
