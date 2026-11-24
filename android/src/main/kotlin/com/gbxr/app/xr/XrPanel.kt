package com.gbxr.app.xr

import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.xr.compose.spatial.Subspace
import androidx.xr.compose.subspace.SpatialPanel
import androidx.xr.compose.subspace.layout.SubspaceModifier
import androidx.xr.compose.subspace.layout.height
import androidx.xr.compose.subspace.layout.movable
import androidx.xr.compose.subspace.layout.width

/** ⚠️ Jetpack Compose for XR (pre-release): shows the crew list as a movable floating panel. */
@Composable
fun XrPanel(content: @Composable () -> Unit) {
    Subspace {
        SpatialPanel(SubspaceModifier.width(900.dp).height(1100.dp).movable()) {
            content()
        }
    }
}
