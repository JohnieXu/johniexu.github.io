$(document).ready(function(){var n=$(".banner .owl-carousel"),e=$(".banner-sub .owl-carousel"),a=$(".main-header .bottom-area .more-btn"),i=$(".main-header .bottom-area .user-btn"),t=$(".main-header .upper-area .lang-area .global"),o=t.next(),s=$("body").css("width");n.owlCarousel({nav:!0,items:1,loop:!0,navSpeed:800,autoplaySpeed:800,autoplay:!0,center:!0,autoplayTimeout:5e3,autoplayHoverPause:!0}),e.owlCarousel({nav:!1,responsiveClass:!0,mouseDrag:!1,touchDrag:!1,responsive:{0:{items:1,margin:5},750:{items:3,margin:5}}}),t.click(function(){$(this).find("a").addClass("active"),o.toggle()}),a.click(function(){i.parent().find(".user-menu").hide(),$(this).parent().find(".main-menu").toggle(),$(this).toggleClass("more-btn-active").find(".line").toggle()}),i.click(function(){a.attr("class").indexOf("more-btn-active")>=0&&(a.parent().find(".main-menu").toggle(),a.toggleClass("more-btn-active").find(".line").toggle()),a.parent().find(".main-menu").hide(),$(this).parent().find(".user-menu").toggle()}),$(".lang-area .menu-lang").css("width",s),$(".banner .owl-item").css("width",s),$(window).resize(function(){var n=$("body").css("width");$(".lang-area .menu-lang").css("width",n),$(".banner .owl-item").css("width",n)});var l=$(".navi-scroll a"),r=$(".navi-scroll .scroll-top-btn");l.each(function(){$(this).hover(function(){$(this).find("span").show()},function(){$(this).find("span").hide()})}),r.click(function(){$("body").animate({scrollTop:0},200)}),$(window).scroll(function(){$(this).scrollTop()>200?$(".navi-scroll").fadeIn():$(".navi-scroll").fadeOut(),"none"!=o.css("display")&&o.hide()}),$(document).click(function(){})});