package com.mchat2

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(LargeMediaPlugin::class.java)
        registerPlugin(DeviceFeaturesPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
