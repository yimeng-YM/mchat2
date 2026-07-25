package com.mchat2;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LargeMediaPlugin.class);
        registerPlugin(DeviceFeaturesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
