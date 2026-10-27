// Runs when the dylib is loaded via DYLD_INSERT_LIBRARIES, before the app's main().
extern void simpeek_start(void);

__attribute__((constructor)) static void simpeek_constructor(void) {
    simpeek_start();
}
