# BOX3D -- Parametric Box & Gridfinity Generator

## Overview
<img width="1038" height="520" alt="Screenshot 2026-01-17 at 3 23 54 AM" src="https://github.com/user-attachments/assets/d7b5dee5-5905-4b1e-80e3-46d1ceb70111" />

BOX3D is a React-based web application designed for generating 3D printable boxes and Gridfinity-compatible storage solutions. It features a real-time 3D visualization engine built with Three.js, allowing users to customize dimensions, structural parameters, and lid styles before exporting print-ready STL files.


## Beta Notice

This software is currently in beta. Features, algorithms, and output formats are subject to change without notice. I make no guarantees of the structural integrety of the boxes (for now).

## Features

### Core Functionality

* **Multi-Unit Support:** Switch seamlessly between Imperial (Inch), Metric (mm), and Gridfinity modes.

* **Real-Time Visualization:** Interactive 3D preview with orbit controls (zoom, pan, rotate).

* **Dimension Overlays:** Live measurement labels for internal capacity, external bounds, and specific feature heights.

* **STL Export:** Generates manifold binary STL files directly in the browser for immediate 3D printing.

### Gridfinity Mode

* **Standard Compliance:** Strictly adheres to Zack Freedman's Gridfinity specifications.

* **Unit-Based Sizing:** Define bins by 42mm grid units (Width/Depth) and 7mm vertical units (Height).

* **Stacking Logic:** - Standard 6U bin height corresponds to a 42mm shoulder height.

  * Includes standard stacking lip (4.4mm) for compatibility.

* **Base Generation:** Automatically generates the standard Gridfinity base profile with magnet holes (6.5mm diameter).

* **Frame Mode:** Option to generate "female" base frames for holding bins.

### Standard Box Mode

* **Measurement Modes:** Define box size by either Internal Capacity (what needs to fit inside) or External Bounds (maximum physical size).

* **Structural Control:** Fine-tune wall thickness and floor thickness.

* **Lid Systems:**

  * **Step Lid:** Friction-fit lid with configurable insert depth and tolerance.

  * **Slide Lid:** Rail-based sliding lid with generated channels and rails.

## Technical Architecture

### Stack

* **Frontend Framework:** React

* **3D Engine:** Three.js (WebGLRenderer, CSS2DRenderer)

* **Styling:** Tailwind CSS

### Engineering Notes

The application utilizes a constraint-based layout engine that calculates geometry from the bottom up (Y=0 upwards):

1. **Feet:** (Gridfinity only) Generates the complex base geometry.

2. **Floor:** Adds the solid bottom plate.

3. **Walls:** Extrudes the main body based on defined height or unit count.

4. **Shoulder/Rim:** Calculates the stacking shoulder height.

5. **Lip/Lid:** Adds the final stacking lip or lid rails.

**Gridfinity Height Calculation:**
The logic ensures strict stacking compliance. The "Units" input defines the stacking shoulder height, not the total physical height.

* Formula: Total Height = (Units \* 7mm) + 4.4mm (Lip).

## Usage

1. **Select Mode:** Choose between Inch, mm, or Gridfinity via the top segmented control.

2. **Configure Dimensions:**

   * For standard boxes, use sliders or text inputs for Width, Depth, and Height.

   * For Gridfinity, set the number of X/Y/Z units.

3. **Adjust Structure:** Modify wall and floor thickness if necessary (defaults are optimized for FDM printing).

4. **Add Features:** Enable lids (Standard Mode) or switch between Bin/Frame types (Gridfinity Mode).

5. **Export:** Click "Download .STL" to save the model.

## Installation

This component is designed to run in a React environment.

1. Ensure `three` and `react` are installed.

2. Import the `App` component.

3. The component is self-contained and handles its own resize observers and rendering loops.
