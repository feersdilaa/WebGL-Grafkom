async function main() {
  const canvas = document.querySelector("#canvas");
  const gl = canvas.getContext("webgl");
  if (!gl) {
    return;
  }

  const meshProgramInfo = webglUtils.createProgramInfo(gl, [vs, fs]);

  const objHref = "data/newbarbel.obj";
  const response = await fetch(objHref);
  const text = await response.text();

  const obj = parseOBJ(text);
  const baseHref = new URL(objHref, window.location.href);
  const matTexts = await Promise.all(
    obj.materialLibs.map(async (filename) => {
      const matHref = new URL(filename, baseHref).href;
      const response = await fetch(matHref);
      return await response.text();
    })
  );
  const materials = parseMTL(matTexts.join("\n"));

  const textures = {
    barbel: await createTexture(gl, "data/material/images.jpg"),
    defaultWhite: create1PixelTexture(gl, [255, 255, 255, 255]),
    defaultNormal: create1PixelTexture(gl, [128, 128, 255, 255]),
  };

  const materialTextures = {
    "Base.001": {
      diffuse: [0.0, 0.0, 0.0],
      shininess: 250,
      defaultNormal: textures.defaultNormal,
    },
    Mesh: {
      diffuseMap: textures.barbel,
      shininess: 250,
      specular: [0.3, 0.3, 0.3],
      defaultNormal: textures.defaultNormal,
    },
  };

  for (const material of Object.values(materials)) {
    Object.entries(material)
      .filter(([key]) => key.endsWith("Map"))
      .forEach(([key, filename]) => {
        let texture = textures[filename];
        if (!texture) {
          const textureHref = new URL(filename, baseHref).href;
          texture = createTexture(gl, textureHref);
          textures[filename] = texture;
        }
        material[key] = texture;
      });
  }

  const defaultMaterial = {
    diffuse: [1, 1, 1],
    diffuseMap: textures.defaultWhite,
    ambient: [0, 0, 0],
    specular: [1, 1, 1],
    specularMap: textures.defaultWhite,
    shininess: 400,
    opacity: 1,
  };

  const parts = obj.geometries.map(({ material, data }, index) => {
    if (data.color) {
      if (data.position.length === data.color.length) {
        data.color = { numComponents: 3, data: data.color };
      }
    } else {
      data.color = { value: [1, 1, 1, 1] };
    }

    if (data.texcoord && data.normal) {
      data.tangent = generateTangents(data.position, data.texcoord, data.indices);
    } else {
      data.tangent = { value: [1, 0, 0] };
    }

    if (!data.texcoord) {
      data.texcoord = { value: [0, 0] };
    }
    if (!data.normal) {
      data.normal = { value: [0, 0, 1] };
    }

    const bufferInfo = webglUtils.createBufferInfoFromArrays(gl, data);

    const isBase001 = material === "Base.001";
    const isMesh = material === "Mesh";

    const materialData = {
      ...defaultMaterial,
      ...(isBase001
        ? materialTextures["Base.001"]
        : materials[material]),
      ...(isMesh ? materialTextures.Mesh : {}),
    };

    return {
      material: materialData,
      bufferInfo,
      renderOrder: isBase001 ? 1 : null,
    };
  });

  // Sort parts by renderOrder
  parts.sort((a, b) => a.renderOrder - b.renderOrder);

  const extents = getGeometriesExtents(obj.geometries);
  const range = m4.subtractVectors(extents.max, extents.min);
  const objOffset = m4.scaleVector(
    m4.addVectors(
      extents.min,
      m4.scaleVector(range, 0.5)),
    -1
  );
  // For rotation control via drag
  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let rotationX = 0;
  let rotationY = 0;

  const cameraTarget = [0, 0, 0.05];
  const radius = m4.length(range) * 0.8;
  let cameraPosition = m4.addVectors(cameraTarget, [0, 0, radius]);
  const zNear = radius / 100;
  const zFar = radius * 3;

  // Animation control
  let isAnimationRunning = true;

  // Dragging functions for rotation
  function startDrag(event) {
    isDragging = true;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
  }

  function stopDrag() {
    isDragging = false;
  }

  function drag(event) {
    if (!isDragging) return;

    const deltaX = event.clientX - lastMouseX;
    const deltaY = event.clientY - lastMouseY;

    const rotationSpeed = 0.01; // Adjust rotation sensitivity
    rotationY += deltaX * rotationSpeed;
    rotationX += deltaY * rotationSpeed;

    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
  }

  // Render function
  function render(time) {
    time *= 0.001;

    webglUtils.resizeCanvasToDisplaySize(gl.canvas);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.enable(gl.DEPTH_TEST);

    const fieldOfViewRadians = 60 * Math.PI / 180;
    const aspect = gl.canvas.clientWidth / gl.canvas.clientHeight;
    const projection = m4.perspective(fieldOfViewRadians, aspect, zNear, zFar);

    const up = [0, 1, 0];

    // Update camera position based on zoom factor
    cameraPosition = m4.addVectors(cameraTarget, [0, 0, radius]);

    const camera = m4.lookAt(cameraPosition, cameraTarget, up);
    const view = m4.inverse(camera);

    const sharedUniforms = {
      u_lightDirection: m4.normalize([-0.5, 0.5, 1]),
      u_ambientLight: [0.35, 0.35, 0.35],
      u_view: view,
      u_projection: projection,
      u_viewWorldPosition: cameraPosition,
    };

    gl.useProgram(meshProgramInfo.program);
    webglUtils.setUniforms(meshProgramInfo, sharedUniforms);

    // Apply rotation only if animation is running
    let u_world;
    if (isAnimationRunning) {
      u_world = m4.yRotation(time + rotationY);
      u_world = m4.xRotate(u_world, rotationX);
    } else {
      u_world = m4.yRotation(rotationY);
      u_world = m4.xRotate(u_world, rotationX);
    }
    u_world = m4.translate(u_world, ...objOffset);

    for (const { bufferInfo, material } of parts) {
      webglUtils.setBuffersAndAttributes(gl, meshProgramInfo, bufferInfo);
      webglUtils.setUniforms(meshProgramInfo, { u_world }, material);
      webglUtils.drawBufferInfo(gl, bufferInfo);
    }

    requestAnimationFrame(render);
  }


  gl.canvas.addEventListener("mousedown", startDrag);
  gl.canvas.addEventListener("mouseup", stopDrag);
  gl.canvas.addEventListener("mousemove", drag);

  // Prevent zoom via mouse wheel
  gl.canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault(); // Block wheel zoom
    },
    { passive: false }
  );

  requestAnimationFrame(render);
}

main();
