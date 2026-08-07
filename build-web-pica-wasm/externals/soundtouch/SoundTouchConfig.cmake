
####### Expanded from @PACKAGE_INIT@ by configure_package_config_file() #######
####### Any changes to this file will be overwritten by the next CMake run ####
####### The input file was SoundTouchConfig.cmake.in                            ########

get_filename_component(PACKAGE_PREFIX_DIR "${CMAKE_CURRENT_LIST_DIR}/../../../" ABSOLUTE)

macro(set_and_check _var _file)
  set(${_var} "${_file}")
  if(NOT EXISTS "${_file}")
    message(FATAL_ERROR "File or directory ${_file} referenced by variable ${_var} does not exist !")
  endif()
endmacro()

macro(check_required_components _NAME)
  foreach(comp ${${_NAME}_FIND_COMPONENTS})
    if(NOT ${_NAME}_${comp}_FOUND)
      if(${_NAME}_FIND_REQUIRED_${comp})
        set(${_NAME}_FOUND FALSE)
      endif()
    endif()
  endforeach()
endmacro()

####################################################################################

include("${CMAKE_CURRENT_LIST_DIR}/SoundTouchTargets.cmake")

check_required_components(SoundTouch)

get_target_property(SoundTouch_LOCATION SoundTouch::SoundTouch LOCATION)
message(STATUS "Found SoundTouch: ${SoundTouch_LOCATION}")

if(OFF)
  check_required_components(SoundTouchDLL)
  get_target_property(SoundTouchDLL_LOCATION SoundTouch::SoundTouchDLL LOCATION)
  message(STATUS "Found SoundTouchDLL: ${SoundTouchDLL_LOCATION}")
endif()
